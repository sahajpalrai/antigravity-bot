// Quick analyzer for a backtest_gate*.json trade log.
// Usage: node scripts/analyze_bt.js <file.json>
'use strict';
const fs = require('fs');
const file = process.argv[2];
const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
const trades = d.trades || [];

function stats(arr) {
  const n = arr.length;
  const wins = arr.filter(t => t.pnl > 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(arr.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  return {
    n, wr: n ? wins.length / n : 0,
    pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
    pnl: gw - gl,
    avg: n ? (gw - gl) / n : 0
  };
}
function fmt(s) {
  const pf = isFinite(s.pf) ? s.pf.toFixed(2) : '∞';
  return `${String(s.n).padStart(5)}t  WR ${(s.wr*100).toFixed(1).padStart(5)}%  PF ${pf.padStart(5)}  ${s.pnl>=0?'+$':'-$'}${Math.abs(s.pnl).toFixed(0).padStart(7)}  avg ${s.avg>=0?'+$':'-$'}${Math.abs(s.avg).toFixed(0)}`;
}

console.log(`\n===== ${file.split(/[\\/]/).pop()} =====`);
console.log(`TOTAL: ${fmt(stats(trades))}`);

// By direction
console.log('\n-- By direction --');
for (const dir of ['Long', 'Short']) {
  console.log(`  ${dir.padEnd(6)}: ${fmt(stats(trades.filter(t => t.direction === dir)))}`);
}

// By symbol × direction
console.log('\n-- Symbol × direction --');
const syms = [...new Set(trades.map(t => t.symbol))];
for (const sym of syms) {
  for (const dir of ['Long', 'Short']) {
    const sub = trades.filter(t => t.symbol === sym && t.direction === dir);
    if (sub.length) console.log(`  ${sym.replace('=F','').padEnd(3)} ${dir.padEnd(6)}: ${fmt(stats(sub))}`);
  }
}

// By symbol × regime × direction — find the bleeders
console.log('\n-- Symbol × regime × direction (sorted by P&L, worst first) --');
const buckets = {};
for (const t of trades) {
  const k = `${t.symbol.replace('=F','')} ${t.regime} ${t.direction}`;
  (buckets[k] = buckets[k] || []).push(t);
}
const rows = Object.entries(buckets).map(([k, arr]) => ({ k, s: stats(arr) }));
rows.sort((a, b) => a.s.pnl - b.s.pnl);
for (const r of rows) console.log(`  ${r.k.padEnd(28)}: ${fmt(r.s)}`);

// What-if: drop buckets with PF < 1.1 (churners barely above water)
console.log('\n-- WHAT-IF: drop buckets with PF < 1.10 --');
const keepKeys = new Set(rows.filter(r => r.s.pf >= 1.10).map(r => r.k));
const kept = trades.filter(t => keepKeys.has(`${t.symbol.replace('=F','')} ${t.regime} ${t.direction}`));
const dropped = rows.filter(r => r.s.pf < 1.10);
console.log(`  Dropped ${dropped.length} buckets (${trades.length - kept.length} trades):`);
for (const r of dropped) console.log(`     ${r.k.padEnd(28)} ${fmt(r.s)}`);
console.log(`  KEPT: ${fmt(stats(kept))}`);

// Exit reason split
console.log('\n-- Exit reason --');
for (const reason of ['TP', 'SL']) {
  const sub = trades.filter(t => t.exitReason === reason);
  console.log(`  ${reason}: ${sub.length} (${(sub.length/trades.length*100).toFixed(0)}%)`);
}
