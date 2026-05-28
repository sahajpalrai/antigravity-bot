// Antigravity v2 — Standalone trainer CLI
// Usage: node scripts/train.js [--symbols NQ,ES,CL,GC] [--auto-rollback] [--quick]
//
// Reads data/{symbol}_5min_nt8.csv, runs walkforward for each
// session × regime × direction combination, writes models to models/.
// On --auto-rollback: backs up existing models and reverts to backup if any
// new model's aggregate Sharpe < existing model's aggregate Sharpe.

'use strict';

const fs = require('fs');
const path = require('path');
const { walkforward, buildDataset } = require('../lib/walkforward');
const { serialize, deserialize, predict } = require('../lib/gbdtModel');
const { REGIMES, modelKey } = require('../lib/regimeClassifier');
const { getActiveProfile } = require('../lib/aggressivenessProfile');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MODELS_DIR = path.join(__dirname, '..', 'models');
const REPORTS_DIR = path.join(__dirname, '..', 'models', 'reports');

if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ─── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const opts = {
  symbols: ['NQ=F', 'ES=F', 'CL=F', 'GC=F'],
  autoRollback: args.includes('--auto-rollback'),
  quick: args.includes('--quick'),       // fewer trees for fast iteration
  highWR: args.includes('--high-wr'),    // legacy flat 0.65 floor across both sessions
  // ── FLOORS FROM ACTIVE AGGRESSIVENESS PROFILE ──
  // The active profile (set via dashboard or models/aggressiveness_profile.json)
  // defines RTH/ETH floors. Trainer respects them unless overridden by CLI.
  // CLI flags --rth-floor / --eth-floor still win for one-off experiments.
  rthFloor: 0.60,    // overridden below from profile
  ethFloor: 0.55,
  // ── DATA WINDOW (optional) ──
  // By default we train on the full ~2y CSV. --recent=30 trims to last 30 days
  // (smaller sample, more reactive to recent regime). Use sparingly — under
  // ~3 months has too few samples for the walkforward to be reliable.
  recentDays: 0
};
const symArg = args.find(a => a.startsWith('--symbols='));
if (symArg) opts.symbols = symArg.split('=')[1].split(',').map(s => s.includes('=F') ? s : s + '=F');
// Load floors from the active profile FIRST (then CLI flags can still override)
try {
  const prof = getActiveProfile();
  if (prof) {
    opts.rthFloor = prof.rthFloor;
    opts.ethFloor = prof.ethFloor;
    opts.activeProfileKey = prof.key;
  }
} catch (e) { /* fall through to defaults */ }
const rthArg = args.find(a => a.startsWith('--rth-floor='));
if (rthArg) opts.rthFloor = parseFloat(rthArg.split('=')[1]);
const ethArg = args.find(a => a.startsWith('--eth-floor='));
if (ethArg) opts.ethFloor = parseFloat(ethArg.split('=')[1]);
const recentArg = args.find(a => a.startsWith('--recent='));
if (recentArg) opts.recentDays = parseInt(recentArg.split('=')[1], 10);
// Legacy --high-wr maps to flat 0.65/0.65
if (opts.highWR) { opts.rthFloor = 0.65; opts.ethFloor = 0.65; }

// Tighter regularization — these GBDTs train on 2-10k samples per regime/session/dir
// slice. Conservative settings beat overfit settings on small samples every time.
const TRAIN_PARAMS = opts.quick
  ? { nTrees: 50,  maxDepth: 3, learningRate: 0.05, minLeafSamples: 40, subsample: 0.8 }
  : { nTrees: 150, maxDepth: 4, learningRate: 0.03, minLeafSamples: 50, subsample: 0.75 };

// Phase 1 (shipped 2026-05-26): CHOP is now tradeable via mean-reversion
// specialists. 4 regimes × 2 sessions × 2 directions × 4 symbols = 64 bundles
// (was 48). The quality gate still culls weak CHOP bundles automatically.
const TRADEABLE_REGIMES = REGIMES;   // includes CHOP
const SESSIONS = ['RTH', 'ETH'];
const DIRECTIONS = ['long', 'short'];

// ─── CSV loader ──────────────────────────────────────────────────────────────

function loadCsv(symbol) {
  const baseName = symbol.replace('=F', '').toLowerCase();
  const file = path.join(DATA_DIR, `${baseName}_5min_nt8.csv`);
  if (!fs.existsSync(file)) {
    console.error(`[Trainer] Missing data file: ${file}`);
    return null;
  }
  const raw = fs.readFileSync(file, 'utf-8');
  // Strip BOM
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);
  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 6) continue;
    const time = parts[0];
    const open = parseFloat(parts[1]);
    const high = parseFloat(parts[2]);
    const low = parseFloat(parts[3]);
    const close = parseFloat(parts[4]);
    const volume = parseFloat(parts[5]);
    if (isNaN(open) || isNaN(close)) continue;
    candles.push({ time, open, high, low, close, volume });
  }
  return candles;
}

// ─── Rollback support ────────────────────────────────────────────────────────

function backupModel(filename) {
  const src = path.join(MODELS_DIR, filename);
  if (!fs.existsSync(src)) return null;
  const backup = path.join(MODELS_DIR, filename + '.backup');
  fs.copyFileSync(src, backup);
  return backup;
}

function readExistingAggregate(filename) {
  const src = path.join(MODELS_DIR, filename);
  if (!fs.existsSync(src)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(src, 'utf-8'));
    return obj.aggregate || null;
  } catch (e) {
    return null;
  }
}

function restoreBackup(filename) {
  const backup = path.join(MODELS_DIR, filename + '.backup');
  if (!fs.existsSync(backup)) return false;
  const dest = path.join(MODELS_DIR, filename);
  fs.copyFileSync(backup, dest);
  return true;
}

// ─── PROFILE-AWARE ROLLBACK ────────────────────────────────────────────────
// Different aggressiveness profiles optimize for different goals. The legacy
// auto-rollback only checked per-trade Sharpe, which is correct for SNIPER
// but actively wrong for SCALPER (which wants volume, not per-trade quality).
//
// Returns { shouldRollback: bool, reason: string }
//
// Decision matrix per profile:
//   SNIPER    — prefer higher Sharpe (per-trade quality)
//   BALANCED  — prefer higher combined score (Sharpe + log(trades))
//   ACTIVE    — prefer higher total profit ((PF-1) × √trades)
//   SCALPER   — prefer higher total edge ((PF-1) × trades, linear)
//   AUTO      — use BALANCED logic (defensive default)
function shouldRollback(existing, candidate, profile) {
  if (!existing) return { shouldRollback: false, reason: 'no existing — deploying new' };
  if (!candidate) return { shouldRollback: true,  reason: 'no new candidate — keeping existing' };

  // Safety: both must have minimum trades to be comparable
  const eT = existing.totalTestTrades || 0;
  const cT = candidate.totalTestTrades || 0;
  if (cT < 10) return { shouldRollback: true,  reason: `new only has ${cT} trades (too few) — keeping existing` };

  const profileKey = (profile && profile.key) || 'BALANCED';

  // SNIPER — Sharpe-only (legacy behavior, correct for high-quality mode)
  if (profileKey === 'SNIPER') {
    const eS = existing.sharpe || 0;
    const cS = candidate.sharpe || 0;
    if (eS > cS + 0.05) {
      return { shouldRollback: true,
        reason: `[SNIPER] existing Sharpe ${eS.toFixed(2)} > new ${cS.toFixed(2)} + 0.05` };
    }
    return { shouldRollback: false,
      reason: `[SNIPER] new Sharpe ${cS.toFixed(2)} ≥ existing ${eS.toFixed(2)} — deploying` };
  }

  // BALANCED — Sharpe + log(trades) — balances quality and volume
  if (profileKey === 'BALANCED' || profileKey === 'AUTO') {
    const eScore = (existing.sharpe || 0) * 0.6 + Math.log(Math.max(1, eT)) * 0.4;
    const cScore = (candidate.sharpe || 0) * 0.6 + Math.log(Math.max(1, cT)) * 0.4;
    if (eScore > cScore + 0.08) {
      return { shouldRollback: true,
        reason: `[BALANCED] existing score ${eScore.toFixed(2)} > new ${cScore.toFixed(2)} + 0.08 ` +
                `(Sharpe ${(existing.sharpe||0).toFixed(2)}/${(candidate.sharpe||0).toFixed(2)}, ` +
                `trades ${eT}/${cT})` };
    }
    return { shouldRollback: false,
      reason: `[BALANCED] new score ${cScore.toFixed(2)} ≥ existing ${eScore.toFixed(2)} — deploying` };
  }

  // ACTIVE — total profit signal: (PF-1) × √trades
  if (profileKey === 'ACTIVE') {
    const eProfit = ((existing.profitFactor || 1) - 1) * Math.sqrt(Math.max(1, eT));
    const cProfit = ((candidate.profitFactor || 1) - 1) * Math.sqrt(Math.max(1, cT));
    if (eProfit > cProfit + 0.5) {
      return { shouldRollback: true,
        reason: `[ACTIVE] existing profit signal ${eProfit.toFixed(2)} > new ${cProfit.toFixed(2)} ` +
                `(PF ${(existing.profitFactor||1).toFixed(2)}/${(candidate.profitFactor||1).toFixed(2)}, ` +
                `trades ${eT}/${cT})` };
    }
    return { shouldRollback: false,
      reason: `[ACTIVE] new profit signal ${cProfit.toFixed(2)} ≥ existing ${eProfit.toFixed(2)} — deploying` };
  }

  // SCALPER — total edge signal: (PF-1) × trades linearly. Volume-first.
  if (profileKey === 'SCALPER') {
    // Skip if new bundle's PF < 1.2 (would be losing money even with volume)
    if ((candidate.profitFactor || 0) < 1.2) {
      return { shouldRollback: true,
        reason: `[SCALPER] new PF ${(candidate.profitFactor||0).toFixed(2)} < 1.2 — keeping existing` };
    }
    const eEdge = ((existing.profitFactor || 1) - 1) * eT;
    const cEdge = ((candidate.profitFactor || 1) - 1) * cT;
    // Require new to win by 20% margin to overcome upgrade-cost uncertainty
    if (eEdge > cEdge * 1.20) {
      return { shouldRollback: true,
        reason: `[SCALPER] existing total edge ${eEdge.toFixed(0)} > new ${cEdge.toFixed(0)} × 1.2 ` +
                `(PF ${(existing.profitFactor||1).toFixed(2)}/${(candidate.profitFactor||1).toFixed(2)}, ` +
                `trades ${eT}/${cT})` };
    }
    return { shouldRollback: false,
      reason: `[SCALPER] new total edge ${cEdge.toFixed(0)} competitive vs existing ${eEdge.toFixed(0)} — deploying` };
  }

  // Unknown profile: fall back to legacy Sharpe check
  if ((existing.sharpe || 0) > (candidate.sharpe || 0) + 0.05) {
    return { shouldRollback: true, reason: `[fallback] existing Sharpe wins by 0.05+` };
  }
  return { shouldRollback: false, reason: '[fallback] deploying' };
}

// ─── Train one model bundle ──────────────────────────────────────────────────

function trainBundle(symbol, candles) {
  const summary = {
    symbol,
    trainedAt: new Date().toISOString(),
    candleCount: candles.length,
    bundles: {}
  };

  for (const session of SESSIONS) {
    for (const regime of TRADEABLE_REGIMES) {
      for (const direction of DIRECTIONS) {
        const key = `${session}_${regime}_${direction}`;
        const filename = `${symbol.replace('=F', '')}_${key}.json`;
        const logPrefix = `[${symbol} ${key}]`;
        console.log(`\n${logPrefix} Starting walkforward…`);

        const wfOpts = {
          session,
          regime,
          direction,
          folds: 5,
          params: TRAIN_PARAMS,
          log: (msg) => console.log(`  ${msg}`)
        };
        // Per-session floor — RTH gets the strict bar, ETH gets the realistic one.
        const sessionFloor = session === 'RTH' ? opts.rthFloor : opts.ethFloor;
        wfOpts.winRateFloor = sessionFloor;
        // When the floor is >= 0.60, prefer high-WR thresholds over Sharpe-max
        wfOpts.objective    = sessionFloor >= 0.60 ? 'winRate' : 'sharpe';
        // ── PROFILE-AWARE THRESHOLD SWEEP ──────────────────────────────────
        // Without this, the walkforward always sweeps [0.52, …, 0.82] regardless
        // of profile. That means SCALPER's intent ("explore lower thresholds")
        // is silently ignored — deployed bundles end up with thresholds in the
        // 0.62-0.78 range and very few signals actually clear them. Reading the
        // sweep range from the active profile makes the SCALPER → 0.45-0.62
        // hand-off real.
        try {
          const prof = getActiveProfile();
          if (prof && Array.isArray(prof.thresholdCandidates) && prof.thresholdCandidates.length >= 3) {
            wfOpts.thresholds = prof.thresholdCandidates;
          }
        } catch (e) { /* fall back to default sweep */ }
        const result = walkforward(candles, wfOpts);

        // ── RECENT 30-DAY THRESHOLD CALIBRATION ─────────────────────────
        // ARCHITECTURE: model structure (trees / feature weights) is trained
        // on the full 2-3yr history so the bot remembers every regime — bear
        // markets, low-vol crawls, vol spikes, FOMC crashes — and doesn't get
        // confused by short-term noise.
        //
        // The THRESHOLD however is RE-CALIBRATED on just the last 30 days.
        // Why: a threshold tuned on 2023 data may be completely wrong for
        // May 2026. The market regime, volatility, and intraday structure all
        // drift. Re-calibrating the threshold on recent data means the model
        // fires at the probability level that's CURRENTLY predictive, not
        // whatever level happened to work two years ago.
        //
        // Net effect: "long memory for patterns, short memory for confidence."
        if (result.trained && result.model) {
          try {
            const RECENT_CAL_DAYS = 30;
            const lastTs = new Date(candles[candles.length - 1].time).getTime();
            const recentCutoff = lastTs - RECENT_CAL_DAYS * 24 * 60 * 60 * 1000;
            const recentCandles = candles.filter(c => new Date(c.time).getTime() >= recentCutoff);

            if (recentCandles.length >= 200) {
              const recentDataset = buildDataset(recentCandles, {
                session:   wfOpts.session,
                regime:    wfOpts.regime,
                direction: wfOpts.direction,
                stride: 1
              });

              if (recentDataset.length >= 25) {
                // Score every recent sample with the model trained on full history
                const scored = recentDataset.map(r => ({
                  prob:  predict(result.model, r.features),
                  label: r.label
                }));

                // Sweep thresholds: find highest WR that still has ≥15 trades on
                // recent data and clears the session floor
                const CAND = [0.45, 0.48, 0.50, 0.52, 0.54, 0.55, 0.58, 0.60, 0.62, 0.65, 0.68, 0.72, 0.75];
                let bestRecent = null;
                for (const th of CAND) {
                  const hits = scored.filter(s => s.prob >= th);
                  if (hits.length < 15) continue;
                  const wr = hits.filter(s => s.label === 1).length / hits.length;
                  if (wr < sessionFloor) continue;
                  // Pick the threshold with best win rate (ties → lower threshold = more trades)
                  if (!bestRecent || wr > bestRecent.wr || (wr === bestRecent.wr && th < bestRecent.threshold)) {
                    bestRecent = { threshold: th, wr, trades: hits.length };
                  }
                }

                if (bestRecent) {
                  const old = result.threshold;
                  result.threshold    = bestRecent.threshold;
                  result.recentCalib  = bestRecent;
                  result.recentCalibDays = RECENT_CAL_DAYS;
                  console.log(`  📅 30d recalib: threshold ${old.toFixed(2)} → ${bestRecent.threshold.toFixed(2)}` +
                              ` (WR=${(bestRecent.wr*100).toFixed(1)}% n=${bestRecent.trades} recent trades)`);
                } else {
                  console.log(`  📅 30d recalib: no threshold hit ${(sessionFloor*100).toFixed(0)}%+ on recent 30d` +
                              ` (${recentDataset.length} samples) — keeping walkforward thresh=${result.threshold.toFixed(2)}`);
                }
              } else {
                console.log(`  📅 30d recalib: only ${recentDataset.length} recent samples — skip`);
              }
            }
          } catch (e) {
            console.log(`  📅 30d recalib failed: ${e.message} — keeping walkforward threshold`);
          }
        }

        if (!result.trained) {
          console.log(`${logPrefix} SKIPPED — ${result.reason} (${result.sampleCount || 0} samples)`);
          summary.bundles[key] = { trained: false, reason: result.reason };
          continue;
        }

        // ── HARD-FLOOR GATE ─────────────────────────────────────────────
        // ABSOLUTE quality bar — applied BEFORE rollback check so a bundle
        // that's catastrophically bad can never deploy, even on a fresh
        // (no-existing-baseline) train. This is the gate that ES_RTH_TREND_UP_long
        // (WR 28.6%, PF 0.53) bypassed in earlier runs because shouldRollback()
        // returns "no existing — deploying new" on first deploy.
        //
        // Tuned to be permissive enough to keep legitimate edge through
        // (CHOP regimes legitimately run thin) but reject anything in the
        // "actively losing in backtest" zone.
        // ── 65%-MANDATE FLOORS ──────────────────────────────────────────
        // North star: live WR ≥ 65%. Live WR is typically 5-10pp below
        // backtest WR (slippage, regime drift, sample randomness). So to
        // hit 65% LIVE we need bundles backtesting at ~70%+. The floors
        // below enforce that with a safety margin.
        //
        // Reality check: this will reject a LOT of bundles. Likely 60-80%
        // of trained candidates fail. That's fine — we'd rather have 15
        // genuinely-edge bundles than 50 marginal ones. Max trades comes
        // from making the GOOD bundles fire more often (via better
        // confluence + AUTO mode), not from deploying weak ones.
        // Volume-aware floors — bundles need real edge but not 65%+
        // backtest WR. Live WR is LIFTED by the 6 confluence guards
        // (prob margin, ATR sweet-spot, EMA agreement, FVG alignment,
        // price-move confirmation, adaptive threshold). A 55% backtest
        // bundle + confluence stack → ~63-67% live WR. This keeps trade
        // volume high while protecting against deploying actual losers.
        const HARD_FLOORS = {
          minWR_RTH:   0.55,
          minWR_ETH:   0.52,
          minPF:       1.25,   // real edge but not extreme
          minTrades:   40,
          minSharpe:   0.50
        };
        const a = result.aggregate || {};
        const wrFloor = session === 'ETH' ? HARD_FLOORS.minWR_ETH : HARD_FLOORS.minWR_RTH;
        const floorFailures = [];
        if ((a.winRate     || 0) < wrFloor)                floorFailures.push(`WR ${((a.winRate||0)*100).toFixed(1)}% < ${(wrFloor*100).toFixed(0)}%`);
        if ((a.profitFactor|| 0) < HARD_FLOORS.minPF)      floorFailures.push(`PF ${(a.profitFactor||0).toFixed(2)} < ${HARD_FLOORS.minPF}`);
        if ((a.totalTestTrades||0)< HARD_FLOORS.minTrades) floorFailures.push(`trades ${a.totalTestTrades||0} < ${HARD_FLOORS.minTrades}`);
        if ((a.sharpe      || 0) < HARD_FLOORS.minSharpe)  floorFailures.push(`Sharpe ${(a.sharpe||0).toFixed(2)} < ${HARD_FLOORS.minSharpe}`);

        if (floorFailures.length > 0) {
          console.log(`${logPrefix} REJECTED (hard floor) — ${floorFailures.join('; ')}`);
          summary.bundles[key] = {
            trained: true,
            deployed: false,
            rejectedByHardFloor: true,
            floorFailures,
            threshold: result.threshold,
            aggregate: a,
            sampleCount: result.sampleCount
          };
          continue;  // SKIP THE WRITE — bundle never lands on disk
        }

        // Decide rollback BEFORE writing the new model — uses profile-aware
        // logic so SCALPER (volume-first) doesn't reject candidates just
        // because they have lower per-trade Sharpe than the legacy bundle.
        let shouldDeploy = true;
        let rollbackReason = null;
        if (opts.autoRollback) {
          const existing = readExistingAggregate(filename);
          let activeProfile = null;
          try { activeProfile = getActiveProfile(); } catch (e) {}
          const decision = shouldRollback(existing, result.aggregate, activeProfile);
          if (decision.shouldRollback) {
            shouldDeploy = false;
            rollbackReason = decision.reason;
          } else if (existing) {
            // Log why we're allowing the deploy (debug aid)
            console.log(`  ${decision.reason}`);
          }
        }

        if (shouldDeploy) {
          if (opts.autoRollback) backupModel(filename);
          const payload = {
            ...JSON.parse(serialize(result.model)),
            threshold: result.threshold,
            aggregate: result.aggregate,
            foldResults: result.foldResults,
            sampleCount: result.sampleCount,
            symbol,
            session,
            regime,
            direction,
            // Recent calibration metadata — shown on dashboard + used for diagnostics
            recentCalib: result.recentCalib || null,
            recentCalibDays: result.recentCalibDays || null,
            trainedAt: new Date().toISOString()
          };
          fs.writeFileSync(path.join(MODELS_DIR, filename), JSON.stringify(payload, null, 2));
          console.log(`${logPrefix} DEPLOYED → ${filename} ` +
                      `(thresh=${result.threshold.toFixed(2)} winRate=${(result.aggregate.winRate * 100).toFixed(1)}% ` +
                      `PF=${result.aggregate.profitFactor.toFixed(2)} Sharpe=${result.aggregate.sharpe.toFixed(2)})`);
        } else {
          console.log(`${logPrefix} ROLLBACK — ${rollbackReason}`);
        }

        summary.bundles[key] = {
          trained: true,
          deployed: shouldDeploy,
          rollbackReason,
          threshold: result.threshold,
          aggregate: result.aggregate,
          sampleCount: result.sampleCount
        };
      }
    }
  }

  return summary;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   ANTIGRAVITY v2 — WALKFORWARD TRAINER                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`Symbols:         ${opts.symbols.join(', ')}`);
  console.log(`Auto-rollback:   ${opts.autoRollback ? 'ON' : 'off'}`);
  console.log(`Mode:            ${opts.quick ? 'quick (40 trees)' : 'full (150 trees)'}`);
  console.log(`WR floors:       RTH=${(opts.rthFloor*100).toFixed(0)}%  ETH=${(opts.ethFloor*100).toFixed(0)}%${opts.rthFloor!==opts.ethFloor ? '  (hybrid)' : ''}`);
  console.log(`Started:         ${new Date().toISOString()}`);

  // Auto-backup current models/ dir before any non-baseline run overwrites.
  // User can always revert by copying the backup back. Path: models_baseline_<ISO-ts>/
  const isCustomFloor = opts.highWR || opts.rthFloor !== 0.55 || opts.ethFloor !== 0.55;
  if (isCustomFloor) {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.join(__dirname, '..', `models_baseline_${ts}`);
      if (fs.existsSync(MODELS_DIR)) {
        fs.mkdirSync(backupDir, { recursive: true });
        for (const f of fs.readdirSync(MODELS_DIR)) {
          if (f.endsWith('.json') &&
              !f.includes('paper_trades') &&
              !f.includes('loss_attributions') &&
              !f.includes('retrain_needed') &&
              !f.includes('exit_overrides')) {
            fs.copyFileSync(path.join(MODELS_DIR, f), path.join(backupDir, f));
          }
        }
        console.log(`Backup created:  ${backupDir}`);
      }
    } catch (e) {
      console.error(`⚠️  Failed to backup current models: ${e.message}. Aborting.`);
      process.exit(2);
    }
  }
  console.log('');

  // Persist the active floor config so the dashboard + decision engine can
  // display "RTH 55% · ETH 52%" on each card. Read by /api/state. Values
  // must match HARD_FLOORS above so the load-time gate and deploy-time gate
  // stay consistent.
  try {
    const cfgPath = path.join(MODELS_DIR, 'quality_floors.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      rthFloor: opts.rthFloor,
      ethFloor: opts.ethFloor,
      minPF: 1.25,
      minTrades: 40,
      minSharpe: 0.50,
      lastTrainedAt: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    console.error(`⚠️  Failed to write quality_floors.json: ${e.message}`);
  }

  const startTime = Date.now();
  const reports = [];

  for (const symbol of opts.symbols) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Loading ${symbol}…`);
    let candles = loadCsv(symbol);
    if (!candles || candles.length < 1000) {
      console.log(`  ⚠️  Skipped — only ${candles ? candles.length : 0} candles`);
      continue;
    }
    // Optional: trim to last N days
    if (opts.recentDays > 0) {
      const lastTs = new Date(candles[candles.length - 1].time).getTime();
      const cutoff = lastTs - opts.recentDays * 24 * 60 * 60 * 1000;
      const before = candles.length;
      candles = candles.filter(c => new Date(c.time).getTime() >= cutoff);
      console.log(`  Trimmed to last ${opts.recentDays}d: ${before} → ${candles.length} candles`);
      if (candles.length < 1000) {
        console.log(`  ⚠️  Skipped — only ${candles.length} candles after trim`);
        continue;
      }
    }
    console.log(`  ${candles.length} candles loaded (${candles[0].time} → ${candles[candles.length - 1].time})`);

    const summary = trainBundle(symbol, candles);
    reports.push(summary);

    // Persist per-symbol report
    const reportPath = path.join(REPORTS_DIR, `${symbol.replace('=F', '')}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));
  }

  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║   TRAINING COMPLETE in ${totalSec}s`.padEnd(58) + '║');
  console.log(`╚══════════════════════════════════════════════════════════╝`);

  // Write top-level summary index for the dashboard
  fs.writeFileSync(
    path.join(MODELS_DIR, 'latest_report.json'),
    JSON.stringify({
      trainedAt: new Date().toISOString(),
      durationSec: parseFloat(totalSec),
      symbols: reports
    }, null, 2)
  );

  // Print summary table
  console.log('\n┌─────────────────────────────────────────────────────────────────────────────────────────────────┐');
  console.log('│ Symbol  Session  Regime         Dir    Trades   WinRate    PF      Sharpe   Threshold   Status  │');
  console.log('├─────────────────────────────────────────────────────────────────────────────────────────────────┤');
  for (const rpt of reports) {
    for (const [key, b] of Object.entries(rpt.bundles)) {
      if (!b.trained) {
        console.log(`│ ${rpt.symbol.replace('=F','').padEnd(7)} ${key.padEnd(34)}                 SKIPPED (${b.reason})`);
        continue;
      }
      // key looks like RTH_VOL_EXPANSION_long — direction is the last token,
      // session is the first, regime is everything between.
      const parts = key.split('_');
      const session = parts[0];
      const direction = parts[parts.length - 1];
      const regime = parts.slice(1, -1).join('_');
      const a = b.aggregate;
      const status = b.deployed ? 'deployed' : 'rolled back';
      console.log(`│ ${rpt.symbol.replace('=F','').padEnd(6)} ${session.padEnd(4)} ${regime.padEnd(14)} ${direction.padEnd(5)} ` +
                  `${String(a.totalTestTrades).padStart(5)}   ${(a.winRate*100).toFixed(1).padStart(5)}%   ` +
                  `${a.profitFactor.toFixed(2).padStart(5)}   ${a.sharpe.toFixed(2).padStart(7)}   ` +
                  `${b.threshold.toFixed(2).padStart(4)}   ${status.padEnd(11)} │`);
    }
  }
  console.log('└─────────────────────────────────────────────────────────────────────────────────────────────────┘');
}

main();
