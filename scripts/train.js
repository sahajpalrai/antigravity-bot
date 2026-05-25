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
const { walkforward } = require('../lib/walkforward');
const { serialize, deserialize } = require('../lib/gbdtModel');
const { REGIMES, modelKey } = require('../lib/regimeClassifier');

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
  quick: args.includes('--quick')   // fewer trees for fast iteration
};
const symArg = args.find(a => a.startsWith('--symbols='));
if (symArg) opts.symbols = symArg.split('=')[1].split(',').map(s => s.includes('=F') ? s : s + '=F');

// Tighter regularization — these GBDTs train on 2-10k samples per regime/session/dir
// slice. Conservative settings beat overfit settings on small samples every time.
const TRAIN_PARAMS = opts.quick
  ? { nTrees: 50,  maxDepth: 3, learningRate: 0.05, minLeafSamples: 40, subsample: 0.8 }
  : { nTrees: 150, maxDepth: 4, learningRate: 0.03, minLeafSamples: 50, subsample: 0.75 };

const TRADEABLE_REGIMES = REGIMES.filter(r => r !== 'CHOP');
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

        const result = walkforward(candles, {
          session,
          regime,
          direction,
          folds: 5,
          params: TRAIN_PARAMS,
          log: (msg) => console.log(`  ${msg}`)
        });

        if (!result.trained) {
          console.log(`${logPrefix} SKIPPED — ${result.reason} (${result.sampleCount || 0} samples)`);
          summary.bundles[key] = { trained: false, reason: result.reason };
          continue;
        }

        // Decide rollback BEFORE writing the new model
        let shouldDeploy = true;
        let rollbackReason = null;
        if (opts.autoRollback) {
          const existing = readExistingAggregate(filename);
          if (existing && existing.sharpe > result.aggregate.sharpe + 0.05) {
            shouldDeploy = false;
            rollbackReason = `existing sharpe ${existing.sharpe.toFixed(2)} > new ${result.aggregate.sharpe.toFixed(2)} — keeping existing`;
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
            direction
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
  console.log(`Mode:            ${opts.quick ? 'quick (40 trees)' : 'full (120 trees)'}`);
  console.log(`Started:         ${new Date().toISOString()}`);
  console.log('');

  const startTime = Date.now();
  const reports = [];

  for (const symbol of opts.symbols) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Loading ${symbol}…`);
    const candles = loadCsv(symbol);
    if (!candles || candles.length < 1000) {
      console.log(`  ⚠️  Skipped — only ${candles ? candles.length : 0} candles`);
      continue;
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
