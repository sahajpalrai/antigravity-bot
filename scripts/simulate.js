// Antigravity v2 — 1-month forward simulator
// Replays the last N days of historical bars through the LIVE decision engine
// (using whichever bundles are currently deployed) and simulates trades to
// produce a true forward-walking performance estimate.
//
// This is different from the walkforward backtest in scripts/train.js:
//   • train.js TRAINS new models and reports their fold-by-fold quality
//   • simulate.js does NOT retrain — it uses whatever's currently on disk
//   • simulate.js shows you "if I had been trading the last 30 days with
//     today's deployed bundles, what would have happened?"
//
// Usage:
//   node scripts/simulate.js [--days=30] [--symbols=NQ,ES,CL,GC]
//   node scripts/simulate.js --days=7 --symbols=NQ
//
// Output: prints per-symbol stats + grand total to stdout.

'use strict';

const fs = require('fs');
const path = require('path');
const { decide, invalidateCache } = require('../lib/decisionEngine');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ALL_SYMBOLS = ['NQ=F', 'ES=F', 'CL=F', 'GC=F'];

// ─── args ───
const args = process.argv.slice(2);
const opts = { days: 30, symbols: ALL_SYMBOLS };
for (const a of args) {
  const m = a.match(/^--(\w+)=(.+)$/);
  if (!m) continue;
  const [, k, v] = m;
  if (k === 'days')    opts.days = parseInt(v, 10);
  if (k === 'symbols') opts.symbols = v.split(',').map(s => s.includes('=F') ? s : `${s}=F`);
}

const CONTRACT_SPECS = {
  'NQ=F': { tickSize: 0.25, pointVal:   20, comm: 4 },
  'ES=F': { tickSize: 0.25, pointVal:   50, comm: 4 },
  'CL=F': { tickSize: 0.01, pointVal: 1000, comm: 4 },
  'GC=F': { tickSize: 0.10, pointVal:  100, comm: 4 }
};

// ─── CSV loader ───
function loadCsv(symbol) {
  const baseName = symbol.replace('=F', '').toLowerCase();
  const file = path.join(DATA_DIR, `${baseName}_5min_nt8.csv`);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf-8');
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
    const low  = parseFloat(parts[3]);
    const close= parseFloat(parts[4]);
    const volume = parseFloat(parts[5]);
    if (isNaN(open) || isNaN(close)) continue;
    candles.push({ time, open, high, low, close, volume });
  }
  return candles;
}

// ─── Simulate one symbol ───
function simulateSymbol(symbol, days) {
  const spec = CONTRACT_SPECS[symbol];
  const candles = loadCsv(symbol);
  if (candles.length === 0) return { symbol, error: 'no data', trades: [] };

  // Cut to last N days
  const lastTs = new Date(candles[candles.length - 1].time).getTime();
  const cutoff = lastTs - days * 24 * 60 * 60 * 1000;
  const startIdx = candles.findIndex(c => new Date(c.time).getTime() >= cutoff);
  if (startIdx < 220) {
    // Need 220 bars warmup; ensure we have enough
    return { symbol, error: 'insufficient warmup data', trades: [] };
  }

  const trades = [];
  let openPos = null;       // current open simulated position
  let entries = 0, exitsSL = 0, exitsTP = 0;

  for (let i = startIdx; i < candles.length; i++) {
    const bar = candles[i];

    // 1. If a position is open, check SL/TP hit on this bar
    if (openPos) {
      let hit = null;
      if (openPos.direction === 'Long') {
        if (bar.low  <= openPos.stopLoss)   hit = { px: openPos.stopLoss,   reason: 'SL' };
        else if (bar.high >= openPos.takeProfit) hit = { px: openPos.takeProfit, reason: 'TP' };
      } else {
        if (bar.high >= openPos.stopLoss)   hit = { px: openPos.stopLoss,   reason: 'SL' };
        else if (bar.low  <= openPos.takeProfit) hit = { px: openPos.takeProfit, reason: 'TP' };
      }
      if (hit) {
        const pts = (hit.px - openPos.entryPrice) * (openPos.direction === 'Long' ? 1 : -1);
        const grossPnl = pts * spec.pointVal;
        const netPnl   = grossPnl - spec.comm;
        const pnlR     = openPos.slDistance > 0 ? pts / openPos.slDistance : 0;
        trades.push({
          symbol,
          direction: openPos.direction,
          entryTime:  openPos.entryTime,
          entryPrice: openPos.entryPrice,
          exitTime:   bar.time,
          exitPrice:  hit.px,
          exitReason: hit.reason,
          pts,
          pnl: netPnl,
          pnlR,
          regime:  openPos.regime,
          session: openPos.session
        });
        if (hit.reason === 'SL') exitsSL++; else exitsTP++;
        openPos = null;
      }
    }

    // 2. If flat, run decision engine on candles[0..i] and consider entry
    if (!openPos) {
      const slice = candles.slice(0, i + 1);
      const decision = decide(symbol, slice);
      if (decision.action === 'BUY' || decision.action === 'SELL') {
        const direction = decision.action === 'BUY' ? 'Long' : 'Short';
        const entry = bar.close;
        const slDist = decision.slDistance;
        const tpDist = decision.tpDistance;
        openPos = {
          direction,
          entryTime: bar.time,
          entryPrice: entry,
          stopLoss:  direction === 'Long' ? entry - slDist : entry + slDist,
          takeProfit:direction === 'Long' ? entry + tpDist : entry - tpDist,
          slDistance: slDist,
          tpDistance: tpDist,
          regime:  decision.regime,
          session: decision.session
        };
        entries++;
      }
    }
  }

  // Aggregate stats
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossW = wins.reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const netPnl = grossW - grossL;
  const wr     = trades.length > 0 ? wins.length / trades.length : 0;
  const pf     = grossL > 0 ? grossW / grossL : (grossW > 0 ? Infinity : 0);

  // Drawdown
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    if (peak - equity > maxDD) maxDD = peak - equity;
  }

  return {
    symbol,
    bars:    candles.length - startIdx,
    entries,
    trades:  trades.length,
    wins:    wins.length,
    losses:  losses.length,
    winRate: wr,
    profitFactor: pf,
    netPnl,
    grossWin:  grossW,
    grossLoss: grossL,
    maxDD,
    exitsTP, exitsSL,
    perRegime: _perRegime(trades),
    perSession: _perSession(trades),
    sampleTrades: trades.slice(-5)
  };
}

function _perRegime(trades) {
  const m = {};
  for (const t of trades) {
    const k = `${t.session}_${t.regime}`;
    if (!m[k]) m[k] = { trades: 0, wins: 0, pnl: 0 };
    m[k].trades++;
    if (t.pnl > 0) m[k].wins++;
    m[k].pnl += t.pnl;
  }
  return m;
}

function _perSession(trades) {
  const m = { RTH: { trades: 0, wins: 0, pnl: 0 }, ETH: { trades: 0, wins: 0, pnl: 0 } };
  for (const t of trades) {
    const k = t.session || 'ETH';
    if (!m[k]) m[k] = { trades: 0, wins: 0, pnl: 0 };
    m[k].trades++;
    if (t.pnl > 0) m[k].wins++;
    m[k].pnl += t.pnl;
  }
  return m;
}

// ─── Main ───
function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log(`║   ANTIGRAVITY v2 — ${opts.days}-DAY FORWARD SIMULATION                       ║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`Symbols: ${opts.symbols.join(', ')}`);
  console.log(`Window:  last ${opts.days} days of 5-min CSV data`);
  console.log(`Engine:  current deployed bundles (no retraining)`);
  console.log('');

  invalidateCache && invalidateCache();

  const startTime = Date.now();
  const results = [];

  for (const sym of opts.symbols) {
    process.stdout.write(`Simulating ${sym}…`);
    const t0 = Date.now();
    const r = simulateSymbol(sym, opts.days);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.error) {
      console.log(`  ✗ ${r.error}`);
      continue;
    }
    console.log(`  done in ${elapsed}s`);
    results.push(r);
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  PER-SYMBOL RESULTS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let grandPnl = 0, grandTrades = 0, grandWins = 0;
  let grandGW = 0, grandGL = 0;

  for (const r of results) {
    const wrStr = (r.winRate * 100).toFixed(1);
    const pfStr = isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞';
    const pnlStr = (r.netPnl >= 0 ? '+$' : '-$') + Math.abs(r.netPnl).toFixed(2);
    console.log('');
    console.log(`  ${r.symbol.replace('=F', '')}  ─────────────────────────────────────`);
    console.log(`    Bars processed:  ${r.bars}`);
    console.log(`    Entries:         ${r.entries}`);
    console.log(`    Trades closed:   ${r.trades}  (TP=${r.exitsTP}, SL=${r.exitsSL})`);
    console.log(`    Win rate:        ${wrStr}%  (${r.wins}W / ${r.losses}L)`);
    console.log(`    Profit factor:   ${pfStr}`);
    console.log(`    Gross win:       $${r.grossWin.toFixed(2)}`);
    console.log(`    Gross loss:      $${r.grossLoss.toFixed(2)}`);
    console.log(`    Net P&L:         ${pnlStr}`);
    console.log(`    Max drawdown:    $${r.maxDD.toFixed(2)}`);
    if (Object.keys(r.perRegime).length > 0) {
      console.log(`    Per regime:`);
      for (const k of Object.keys(r.perRegime)) {
        const v = r.perRegime[k];
        const subWR = v.trades > 0 ? (v.wins / v.trades * 100).toFixed(0) : '—';
        console.log(`      ${k.padEnd(28)}  ${String(v.trades).padStart(3)}t · WR ${subWR}% · P&L $${v.pnl.toFixed(0)}`);
      }
    }
    grandPnl += r.netPnl;
    grandTrades += r.trades;
    grandWins += r.wins;
    grandGW += r.grossWin;
    grandGL += r.grossLoss;
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  GRAND TOTAL — ALL SYMBOLS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const gWR = grandTrades > 0 ? (grandWins / grandTrades * 100).toFixed(1) : '—';
  const gPF = grandGL > 0 ? (grandGW / grandGL).toFixed(2) : '∞';
  console.log(`  Total trades:   ${grandTrades}`);
  console.log(`  Win rate:       ${gWR}%`);
  console.log(`  Profit factor:  ${gPF}`);
  console.log(`  Net P&L:        ${grandPnl >= 0 ? '+$' : '-$'}${Math.abs(grandPnl).toFixed(2)}`);
  console.log(`  Trades / day:   ${grandTrades > 0 ? (grandTrades / opts.days).toFixed(1) : '0'}`);
  console.log(`  Time elapsed:   ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log('');

  // Write JSON report for the dashboard
  const reportPath = path.join(__dirname, '..', 'models', `simulation_${opts.days}d_${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    generated: new Date().toISOString(),
    windowDays: opts.days,
    symbols: opts.symbols,
    perSymbol: results,
    grandTotal: {
      trades: grandTrades,
      wins: grandWins,
      winRate: grandTrades > 0 ? grandWins / grandTrades : 0,
      profitFactor: grandGL > 0 ? grandGW / grandGL : 0,
      netPnl: grandPnl,
      tradesPerDay: grandTrades > 0 ? grandTrades / opts.days : 0
    }
  }, null, 2));
  console.log(`Saved: ${path.basename(reportPath)}`);
}

main();
