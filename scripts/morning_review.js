// Antigravity v2 — Automated morning honest-numbers review (post-retrain)
// ---------------------------------------------------------------------------
// Runs AFTER the nightly purged-CV retrain. Deterministic + auditable (no LLM).
//
// Pipeline:
//   1. Confirm the retrain actually ran (fresh NQ bundle mtimes).
//   2. Measure HONEST NQ-long performance over 3yr with the gate bypassed
//      (BT_NO_GATE=1) on the freshly-retrained (purged) models.
//   3. Apply guardrails per NQ long bucket: PF>=1.5, WR>=0.45, trades>=40.
//   4. Force-enable ONLY the buckets that pass (models/enabled_bundles.json).
//      The list is startup-only, so it goes LIVE on the NEXT server restart —
//      never mid-session. Fully reversible (git tag).
//   5. Commit + tag + Telegram a full report.
//
// Auto-apply WITH guardrails, per user decision 2026-05-30. If nothing clears
// the bar, it changes nothing and just reports.
//
// Usage:  node scripts/morning_review.js [--dry-run]
'use strict';

process.env.BACKTEST = '1';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MODELS = path.join(ROOT, 'models');
const ENABLED_FILE = path.join(MODELS, 'enabled_bundles.json');
const LOG_FILE = path.join(ROOT, 'logs', 'morning_review.log');
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');   // skip the retrain-freshness gate (manual runs)

// Guardrails — a bucket must clear ALL of these on the HONEST backtest to deploy.
const GUARD = { minPF: 1.5, minWR: 0.45, minTrades: 40 };

// Candidate NQ long buckets to consider unlocking (currently gated by WR floor).
const CANDIDATES = [
  { stem: 'NQ_RTH_VOL_EXPANSION_long', regime: 'VOL_EXPANSION' },
  { stem: 'NQ_RTH_CHOP_long',          regime: 'CHOP' },
  { stem: 'NQ_RTH_TREND_UP_long',      regime: 'TREND_UP' },
  { stem: 'NQ_RTH_TREND_DOWN_long',    regime: 'TREND_DOWN' }
];

let _tg = () => {};
try { _tg = require(path.join(ROOT, 'lib', 'telegram')).sendTelegramMessage; } catch (e) {}

function log(m) {
  const line = `[MorningReview ${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}
function telegram(msg) {
  try { _tg(msg, { kind: 'system', header: '🌅 *Antigravity — Morning Review*' }); } catch (e) {}
}
function sh(cmd, extraEnv) {
  return execSync(cmd, {
    cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    env: extraEnv ? Object.assign({}, process.env, extraEnv) : process.env
  });
}

// ── 1. Confirm retrain freshness ──────────────────────────────────────────────
function retrainIsFresh() {
  // At least one NQ bundle modified in the last 12h => retrain ran overnight.
  const probe = ['NQ_RTH_VOL_EXPANSION_long', 'NQ_RTH_TREND_DOWN_short', 'NQ_ETH_CHOP_long'];
  const now = Date.now();
  for (const stem of probe) {
    const f = path.join(MODELS, stem + '.json');
    try {
      const ageH = (now - fs.statSync(f).mtimeMs) / 3.6e6;
      if (ageH <= 12) return { fresh: true, ageH };
    } catch (e) {}
  }
  return { fresh: false };
}

// ── 2. Honest backtest (gate bypassed) → per-bucket NQ long stats ──────────────
function honestNqLongBuckets() {
  log('Running honest NQ backtest (BT_NO_GATE=1, full history)…');
  sh('node scripts/backtest_gates.js --gate=1 --days=ALL --symbols=NQ', { BT_NO_GATE: '1' });
  // newest NQ backtest json
  const files = fs.readdirSync(MODELS).filter(f => /^backtest_gate1_ALL_\d+\.json$/.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(MODELS, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error('no backtest output produced');
  const data = JSON.parse(fs.readFileSync(path.join(MODELS, files[0].f), 'utf-8'));
  const trades = (data.trades || []).filter(t => t.symbol === 'NQ=F' && t.direction === 'Long');

  const byRegime = {};
  for (const t of trades) {
    const k = t.regime;
    (byRegime[k] = byRegime[k] || []).push(t);
  }
  const out = {};
  for (const c of CANDIDATES) {
    const arr = byRegime[c.regime] || [];
    const wins = arr.filter(t => t.pnl > 0);
    const gw = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(arr.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    out[c.stem] = {
      regime: c.regime,
      trades: arr.length,
      wr: arr.length ? wins.length / arr.length : 0,
      pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
      pnl: gw - gl
    };
  }
  return out;
}

// ── 3+4. Apply guardrails, build new enable list ──────────────────────────────
function decide(buckets) {
  const pass = [], fail = [];
  for (const c of CANDIDATES) {
    const b = buckets[c.stem];
    const ok = b && b.trades >= GUARD.minTrades && b.wr >= GUARD.minWR && b.pf >= GUARD.minPF;
    (ok ? pass : fail).push({ stem: c.stem, ...b });
  }
  return { pass, fail };
}

function fmtRow(r) {
  const pf = isFinite(r.pf) ? r.pf.toFixed(2) : '∞';
  return `${r.stem}: ${r.trades}t WR ${(r.wr * 100).toFixed(0)}% PF ${pf} ${r.pnl >= 0 ? '+$' : '-$'}${Math.abs(r.pnl).toFixed(0)}`;
}

function main() {
  log(`=== START${DRY ? ' (dry-run)' : ''} ===`);
  try {
    const fresh = retrainIsFresh();
    if (!fresh.fresh && !FORCE) {
      log('Retrain not detected (no NQ bundle <12h old). Skipping.');
      telegram('⚠️ Retrain not detected (no fresh NQ bundle). No review run — will retry next schedule.');
      return;
    }
    log(fresh.fresh ? `Retrain fresh (newest NQ bundle ${fresh.ageH.toFixed(1)}h old).` : 'FORCE: skipping freshness gate (manual run).');

    const buckets = honestNqLongBuckets();
    log('Honest NQ long buckets: ' + JSON.stringify(buckets));
    const { pass, fail } = decide(buckets);

    const report = [
      `Honest (purged) 3yr NQ-long review — guardrails PF≥${GUARD.minPF} WR≥${(GUARD.minWR*100)}% trades≥${GUARD.minTrades}`,
      '',
      '✅ PASS (will enable):',
      ...(pass.length ? pass.map(r => '  ' + fmtRow(r)) : ['  (none)']),
      '',
      '❌ HELD (stay gated):',
      ...(fail.length ? fail.map(r => '  ' + fmtRow(r)) : ['  (none)'])
    ];

    // Build new enable map (preserve any non-NQ-long entries already present)
    let current = { enabled: {} };
    try { current = JSON.parse(fs.readFileSync(ENABLED_FILE, 'utf-8')); } catch (e) {}
    const candidateStems = new Set(CANDIDATES.map(c => c.stem));
    const newEnabled = {};
    // keep entries that aren't our candidates (don't clobber anything else)
    for (const [k, v] of Object.entries(current.enabled || {})) {
      if (!candidateStems.has(k)) newEnabled[k] = v;
    }
    for (const r of pass) {
      newEnabled[r.stem] = `Auto-enabled ${new Date().toISOString().slice(0,10)} by morning_review: honest 3yr ${r.trades}t, WR ${(r.wr*100).toFixed(0)}%, PF ${isFinite(r.pf)?r.pf.toFixed(2):'inf'}. Cleared guardrails.`;
    }

    const changed = JSON.stringify(newEnabled) !== JSON.stringify(current.enabled || {});

    if (DRY) {
      log('DRY-RUN — would write enabled list: ' + JSON.stringify(newEnabled));
      telegram(report.concat(['', '(dry-run — nothing written)']).join('\n'));
      return;
    }

    if (!changed) {
      log('Enable list unchanged. Nothing to commit.');
      telegram(report.concat(['', 'No change vs current enable list — nothing applied.']).join('\n'));
      return;
    }

    // Write + commit + tag
    const payload = {
      _note: current._note || 'Force-enable list (startup-only). Managed by morning_review.js.',
      enabled: newEnabled
    };
    fs.writeFileSync(ENABLED_FILE, JSON.stringify(payload, null, 2));
    log('Wrote enabled_bundles.json');

    const tag = `auto-nqlong-${new Date().toISOString().slice(0,10)}`;
    try {
      sh('git add models/enabled_bundles.json');
      sh(`git commit -m "auto(morning_review): enable ${pass.length} NQ long bucket(s) on honest numbers"`);
      sh(`git tag -f ${tag}`);
      try { sh('git push origin main'); sh(`git push origin ${tag} --force`); } catch (e) { log('push failed (offline?) — committed locally'); }
      log(`Committed + tagged ${tag}`);
    } catch (e) {
      log('git commit issue: ' + (e.message || e));
    }

    telegram(report.concat([
      '',
      `🟢 APPLIED — ${pass.length} bucket(s) force-enabled.`,
      'Takes effect on the NEXT server restart (5 AM auto-start, or restart now).',
      `Rollback: git reset --hard ${tag}~1  (tag ${tag})`
    ]).join('\n'));
    log('=== DONE ===');

  } catch (e) {
    log('ERROR: ' + (e && e.stack || e));
    telegram('❌ Morning review FAILED: ' + (e && e.message || e) + '\nNo changes applied. Check logs/morning_review.log.');
  }
}

main();
