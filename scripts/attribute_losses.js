'use strict';
// Loss attribution for a Gate-1 backtest file. Breaks net P&L down by hour,
// regime×direction, symbol×session, exit reason, and year — to find exactly
// where the edge is and where it bleeds.  Usage: node attribute_losses.js <file>
const fs = require('fs');
const file = process.argv[2] || fs.readdirSync('models').filter(f => /^backtest_gate1_ALL_/.test(f)).map(f => 'models/' + f).sort().pop();
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const trades = d.trades || [];

function pf(rows) {
  let w = 0, l = 0, win = 0, n = rows.length, pnl = 0;
  for (const r of rows) { pnl += r.pnl; if (r.pnl >= 0) { w += r.pnl; win++; } else l += -r.pnl; }
  return { n, pnl: Math.round(pnl), wr: n ? (100 * win / n).toFixed(1) : '0', pf: l ? (w / l).toFixed(2) : '∞' };
}
function group(keyFn) {
  const m = {};
  for (const r of trades) { const k = keyFn(r); if (k == null) continue; (m[k] = m[k] || []).push(r); }
  return Object.entries(m).map(([k, rows]) => ({ k, ...pf(rows) }));
}
function hourPT(r) { // entryTime "2023-05-24 17:55:00-07:00" → hour
  const m = /\s(\d{2}):/.exec(r.entryTime); return m ? m[1] : null;
}
function show(title, rows, sortByPnl) {
  console.log('\n=== ' + title + ' ===');
  if (sortByPnl) rows.sort((a, b) => a.pnl - b.pnl); else rows.sort((a, b) => a.k < b.k ? -1 : 1);
  for (const r of rows) {
    const bar = r.pnl < 0 ? '  <== BLEED' : '';
    console.log(`${String(r.k).padEnd(22)} n=${String(r.n).padStart(5)}  WR=${String(r.wr).padStart(5)}%  PF=${String(r.pf).padStart(5)}  net=$${String(r.pnl).padStart(8)}${bar}`);
  }
}
console.log('FILE:', file, '| trades:', trades.length, '| overall', JSON.stringify(pf(trades)));
show('BY ENTRY HOUR (PT)', group(hourPT), false);
show('BY REGIME × DIRECTION', group(r => r.regime + ' ' + r.direction), true);
show('BY SYMBOL × SESSION', group(r => r.symbol + ' ' + r.session), true);
show('BY EXIT REASON', group(r => r.exitReason), true);
show('BY YEAR', group(r => r.year), false);
// R-multiple distribution
const rs = trades.map(t => t.pnlR).filter(x => x != null).sort((a, b) => a - b);
if (rs.length) {
  const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
  console.log(`\n=== R-MULTIPLE === avg=${avg.toFixed(3)}R  median=${rs[Math.floor(rs.length/2)].toFixed(2)}R  min=${rs[0].toFixed(2)}  max=${rs[rs.length-1].toFixed(2)}`);
}
