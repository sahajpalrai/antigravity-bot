// Dry-run audit of the new profile-aware rollback logic.
// Replays the 32 rollback decisions from the latest --quick retrain log
// using both the OLD (Sharpe-only) and NEW (profile-aware) rollback functions,
// then prints how many would deploy under each profile.

'use strict';

const fs = require('fs');
const path = require('path');

// Find the latest retrain log
const logsDir = path.join(__dirname, '..', 'models', 'retrain_logs');
const logs = fs.readdirSync(logsDir)
  .filter(f => f.startsWith('quick_phase1_') && f.endsWith('.log'))
  .map(f => ({ f, mtime: fs.statSync(path.join(logsDir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
if (logs.length === 0) { console.log('No quick_phase1 log found'); process.exit(0); }

const log = fs.readFileSync(path.join(logsDir, logs[0].f), 'utf-8');

// Parse rollback lines into structured records
const rollbackRegex = /\[(\w+=F)\s+(RTH|ETH)_(\w+)_(long|short)\]\s+ROLLBACK[^0-9]+existing sharpe (-?[\d.]+).*new (-?[\d.]+)/g;
const decisions = [];
let m;
while ((m = rollbackRegex.exec(log)) !== null) {
  decisions.push({
    bundle:  `${m[1]} ${m[2]}_${m[3]}_${m[4]}`,
    existing: { sharpe: parseFloat(m[5]) },
    candidate:{ sharpe: parseFloat(m[6]) }
  });
}

// Parse the per-symbol summary table at the end for full aggregate stats
// Format example (from logs):
//   "GC     ETH  TREND_UP       short   225    55.6%    2.12      5.81   0.65   deployed"
const tableRegex = /(NQ|ES|CL|GC)\s+(RTH|ETH)\s+(\w+)\s+(long|short)\s+(\d+)\s+([\d.]+)%\s+([\d.]+)\s+(-?[\d.]+)\s+[\d.]+\s+(\w+)/g;
const summary = {};
while ((m = tableRegex.exec(log)) !== null) {
  const key = `${m[1]}=F ${m[2]}_${m[3]}_${m[4]}`;
  summary[key] = {
    trades: parseInt(m[5], 10),
    winRate: parseFloat(m[6]) / 100,
    profitFactor: parseFloat(m[7]),
    sharpe: parseFloat(m[8]),
    state: m[9]
  };
}

// Enrich each rollback decision with full aggregate stats from the summary table
for (const d of decisions) {
  const s = summary[d.bundle];
  if (s) {
    d.candidate.totalTestTrades = s.trades;
    d.candidate.profitFactor    = s.profitFactor;
    d.candidate.winRate         = s.winRate;
  }
}

// Try to read existing's full aggregate from the actual model JSON
for (const d of decisions) {
  const [sym, key] = d.bundle.split(' ');
  const filename = `${sym.replace('=F','')}_${key}.json`;
  const modelPath = path.join(__dirname, '..', 'models', filename);
  if (fs.existsSync(modelPath)) {
    try {
      const obj = JSON.parse(fs.readFileSync(modelPath, 'utf-8'));
      if (obj.aggregate) {
        d.existing.totalTestTrades = obj.aggregate.totalTestTrades;
        d.existing.profitFactor    = obj.aggregate.profitFactor;
        d.existing.winRate         = obj.aggregate.winRate;
      }
    } catch (e) {}
  }
}

// Inline the rollback function (mirror of scripts/train.js implementation)
function shouldRollback(existing, candidate, profile) {
  if (!existing) return { shouldRollback: false, reason: 'no existing — deploying new' };
  if (!candidate) return { shouldRollback: true,  reason: 'no new candidate — keeping existing' };
  const eT = existing.totalTestTrades || 0;
  const cT = candidate.totalTestTrades || 0;
  if (cT < 10) return { shouldRollback: true,  reason: `new only has ${cT} trades (too few)` };
  const profileKey = (profile && profile.key) || 'BALANCED';
  if (profileKey === 'SNIPER') {
    const eS = existing.sharpe || 0;
    const cS = candidate.sharpe || 0;
    if (eS > cS + 0.05) {
      return { shouldRollback: true, reason: `[SNIPER] existing Sharpe ${eS.toFixed(2)} > new ${cS.toFixed(2)} + 0.05` };
    }
    return { shouldRollback: false, reason: `[SNIPER] new Sharpe ${cS.toFixed(2)} ≥ existing ${eS.toFixed(2)}` };
  }
  if (profileKey === 'BALANCED' || profileKey === 'AUTO') {
    const eScore = (existing.sharpe || 0) * 0.6 + Math.log(Math.max(1, eT)) * 0.4;
    const cScore = (candidate.sharpe || 0) * 0.6 + Math.log(Math.max(1, cT)) * 0.4;
    if (eScore > cScore + 0.08) {
      return { shouldRollback: true, reason: `[BALANCED] existing score ${eScore.toFixed(2)} > new ${cScore.toFixed(2)} + 0.08 (Sharpe ${(existing.sharpe||0).toFixed(2)}/${(candidate.sharpe||0).toFixed(2)}, trades ${eT}/${cT})` };
    }
    return { shouldRollback: false, reason: `[BALANCED] new score ${cScore.toFixed(2)} ≥ existing ${eScore.toFixed(2)}` };
  }
  if (profileKey === 'ACTIVE') {
    const eProfit = ((existing.profitFactor || 1) - 1) * Math.sqrt(Math.max(1, eT));
    const cProfit = ((candidate.profitFactor || 1) - 1) * Math.sqrt(Math.max(1, cT));
    if (eProfit > cProfit + 0.5) {
      return { shouldRollback: true, reason: `[ACTIVE] existing profit ${eProfit.toFixed(2)} > new ${cProfit.toFixed(2)} (PF ${(existing.profitFactor||1).toFixed(2)}/${(candidate.profitFactor||1).toFixed(2)}, trades ${eT}/${cT})` };
    }
    return { shouldRollback: false, reason: `[ACTIVE] new profit ${cProfit.toFixed(2)} ≥ existing ${eProfit.toFixed(2)}` };
  }
  if (profileKey === 'SCALPER') {
    if ((candidate.profitFactor || 0) < 1.2) {
      return { shouldRollback: true, reason: `[SCALPER] new PF ${(candidate.profitFactor||0).toFixed(2)} < 1.2 — keeping existing` };
    }
    const eEdge = ((existing.profitFactor || 1) - 1) * eT;
    const cEdge = ((candidate.profitFactor || 1) - 1) * cT;
    if (eEdge > cEdge * 1.20) {
      return { shouldRollback: true, reason: `[SCALPER] existing edge ${eEdge.toFixed(0)} > new ${cEdge.toFixed(0)} × 1.2 (PF ${(existing.profitFactor||1).toFixed(2)}/${(candidate.profitFactor||1).toFixed(2)}, trades ${eT}/${cT})` };
    }
    return { shouldRollback: false, reason: `[SCALPER] new edge ${cEdge.toFixed(0)} competitive vs existing ${eEdge.toFixed(0)}` };
  }
  if ((existing.sharpe || 0) > (candidate.sharpe || 0) + 0.05) {
    return { shouldRollback: true, reason: `[fallback] existing Sharpe wins by 0.05+` };
  }
  return { shouldRollback: false, reason: '[fallback] deploying' };
}

// OLD rollback (legacy Sharpe-only)
function oldShouldRollback(existing, candidate) {
  if (!existing || !candidate) return false;
  if ((existing.sharpe || 0) > (candidate.sharpe || 0) + 0.05) return true;
  return false;
}

// Replay decisions under each profile
const profiles = [
  { key: 'SNIPER' },
  { key: 'BALANCED' },
  { key: 'ACTIVE' },
  { key: 'SCALPER' }
];

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  AUDIT: Replay 32 rollback decisions under NEW profile-aware logic');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('');
console.log(`Found ${decisions.length} rollback decisions in latest log`);
console.log(`Decisions with full aggregate stats: ${decisions.filter(d => d.candidate.totalTestTrades).length}`);
console.log('');

console.log('─── How each profile would handle the same decisions ───');
console.log('');
const header = `  ${'Profile'.padEnd(10)} ${'Rollback'.padEnd(10)} ${'Deploy'.padEnd(8)} ${'% Deploy'}`;
console.log(header);
console.log('  ' + '─'.repeat(45));

for (const p of profiles) {
  let rb = 0, dp = 0;
  for (const d of decisions) {
    const r = shouldRollback(d.existing, d.candidate, p);
    if (r.shouldRollback) rb++; else dp++;
  }
  const pct = decisions.length > 0 ? Math.round(dp / decisions.length * 100) : 0;
  console.log(`  ${p.key.padEnd(10)} ${rb.toString().padEnd(10)} ${dp.toString().padEnd(8)} ${pct}%`);
}

// Also show old logic for reference
let oldRb = 0, oldDp = 0;
for (const d of decisions) {
  if (oldShouldRollback(d.existing, d.candidate)) oldRb++; else oldDp++;
}
console.log(`  ${'OLD'.padEnd(10)} ${oldRb.toString().padEnd(10)} ${oldDp.toString().padEnd(8)} ${Math.round(oldDp / decisions.length * 100)}%`);

console.log('');
console.log('─── Sample decisions per profile (first 5) ───');
for (const p of profiles) {
  console.log('');
  console.log(`  Profile: ${p.key}`);
  for (const d of decisions.slice(0, 5)) {
    const r = shouldRollback(d.existing, d.candidate, p);
    const verdict = r.shouldRollback ? '✗ ROLLBACK' : '✓ DEPLOY';
    console.log(`    ${verdict}  ${d.bundle}  — ${r.reason}`);
  }
}
