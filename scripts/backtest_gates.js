// Antigravity v2 — Faithful multi-year gate backtester
// ---------------------------------------------------------------------------
// Replays historical 5-min bars through the REAL decision engine (Gate 1) or
// the REAL gate2 engine (Gate 2) and simulates intrabar SL/TP outcomes.
//
// Why this exists (vs scripts/simulate.js):
//   • simulate.js feeds the FULL history slice (0..i) to decide() each bar —
//     that's O(n^2) and, worse, UNFAITHFUL: live trading only ever sees a
//     rolling 500-bar buffer (lib/nt8Bridge.js CANDLE_BUFFER_SIZE = 500).
//   • This harness feeds exactly the last 500 bars, matching live byte-for-byte,
//     and runs in O(n).
//   • Sets BACKTEST=1 so decisionEngine skips the wall-clock news gate (the
//     news feed is relative to *today*, so it cannot gate 2023 bars correctly).
//
// NT8 Strategy Tester note: the Antigravity brain is EXTERNAL (this Node
// process). NT8's .cs is a thin bridge that just forwards bars over TCP — so
// NT8's Strategy Tester literally cannot backtest the strategy. THIS is the
// faithful equivalent: it runs the exact same decide()/decide2() code path
// that fires live orders.
//
// Usage:
//   node scripts/backtest_gates.js --gate=1 [--days=ALL] [--symbols=NQ,ES,CL,GC]
//   node scripts/backtest_gates.js --gate=2 --days=180 --symbols=NQ
//
// Gate 2 requires the pattern engine running on :3100
// (gate2/scripts/start_pattern_engine.bat).
'use strict';

process.env.BACKTEST = process.env.BACKTEST || '1';

const fs = require('fs');
const path = require('path');
const { decide, invalidateCache } = require('../lib/decisionEngine');
const gate2 = require('../lib/gate2Engine');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ALL_SYMBOLS = ['NQ=F', 'ES=F', 'CL=F', 'GC=F'];
const LIVE_BUFFER = 500;   // must match lib/nt8Bridge.js CANDLE_BUFFER_SIZE
const WARMUP = 220;        // featureEngineer needs ~220 bars

const CONTRACT_SPECS = {
  'NQ=F': { tickSize: 0.25, pointVal:   20, comm: 4 },
  'ES=F': { tickSize: 0.25, pointVal:   50, comm: 4 },
  'CL=F': { tickSize: 0.01, pointVal: 1000, comm: 4 },
  'GC=F': { tickSize: 0.10, pointVal:  100, comm: 4 }
};

// ─── args ───
const args = process.argv.slice(2);
const opts = { gate: 1, days: 'ALL', symbols: ALL_SYMBOLS };
for (const a of args) {
  const m = a.match(/^--(\w+)=(.+)$/);
  if (!m) continue;
  const [, k, v] = m;
  if (k === 'gate')    opts.gate = parseInt(v, 10);
  if (k === 'days')    opts.days = (v.toUpperCase() === 'ALL') ? 'ALL' : parseInt(v, 10);
  if (k === 'symbols') opts.symbols = v.split(',').map(s => s.includes('=F') ? s : `${s}=F`);
}

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
    const open = parseFloat(parts[1]);
    const high = parseFloat(parts[2]);
    const low  = parseFloat(parts[3]);
    const close= parseFloat(parts[4]);
    const volume = parseFloat(parts[5]);
    if (isNaN(open) || isNaN(close)) continue;
    candles.push({ time: parts[0], open, high, low, close, volume });
  }
  return candles;
}

function yearOf(t) { return String(t).slice(0, 4); }

// ─── Simulate one symbol ───
async function simulateSymbol(symbol, gateNum) {
  const spec = CONTRACT_SPECS[symbol];
  const candles = loadCsv(symbol);
  if (candles.length === 0) return { symbol, error: 'no data' };

  // Determine start index
  let startIdx = WARMUP;
  if (opts.days !== 'ALL') {
    const lastTs = new Date(candles[candles.length - 1].time).getTime();
    const cutoff = lastTs - opts.days * 24 * 60 * 60 * 1000;
    const di = candles.findIndex(c => new Date(c.time).getTime() >= cutoff);
    startIdx = Math.max(WARMUP, di);
  }
  if (startIdx >= candles.length - 1) return { symbol, error: 'insufficient data' };

  const trades = [];
  let openPos = null;
  let entries = 0, exitsSL = 0, exitsTP = 0;

  for (let i = startIdx; i < candles.length; i++) {
    const bar = candles[i];

    // 1. Manage open position — intrabar SL/TP (SL checked first = conservative)
    if (openPos) {
      let hit = null;
      if (openPos.direction === 'Long') {
        if (bar.low  <= openPos.stopLoss)        hit = { px: openPos.stopLoss,   reason: 'SL' };
        else if (bar.high >= openPos.takeProfit) hit = { px: openPos.takeProfit, reason: 'TP' };
      } else {
        if (bar.high >= openPos.stopLoss)        hit = { px: openPos.stopLoss,   reason: 'SL' };
        else if (bar.low  <= openPos.takeProfit) hit = { px: openPos.takeProfit, reason: 'TP' };
      }
      if (hit) {
        const pts = (hit.px - openPos.entryPrice) * (openPos.direction === 'Long' ? 1 : -1);
        const netPnl = pts * spec.pointVal - spec.comm;
        trades.push({
          symbol, direction: openPos.direction,
          entryTime: openPos.entryTime, entryPrice: openPos.entryPrice,
          exitTime: bar.time, exitPrice: hit.px, exitReason: hit.reason,
          pts, pnl: netPnl,
          pnlR: openPos.slDistance > 0 ? pts / openPos.slDistance : 0,
          regime: openPos.regime, session: openPos.session,
          year: yearOf(openPos.entryTime)
        });
        if (hit.reason === 'SL') exitsSL++; else exitsTP++;
        openPos = null;
      }
    }

    // 2. If flat, run the gate's decision on the last LIVE_BUFFER bars
    if (!openPos) {
      const lo = Math.max(0, i + 1 - LIVE_BUFFER);
      const window = candles.slice(lo, i + 1);
      let decision;
      if (gateNum === 2) {
        // Inject bar wall-clock so gate2's time/cooldown gates evaluate against
        // the historical bar, not "now".
        const nowMs = new Date(bar.time).getTime();
        decision = await gate2.decide2(symbol, window, { nowMs });
      } else {
        decision = decide(symbol, window);
      }
      if (decision.action === 'BUY' || decision.action === 'SELL') {
        const direction = decision.action === 'BUY' ? 'Long' : 'Short';
        const entry  = bar.close;
        const slDist = decision.slDistance;
        const tpDist = decision.tpDistance;
        if (slDist > 0 && tpDist > 0) {
          openPos = {
            direction, entryTime: bar.time, entryPrice: entry,
            stopLoss:   direction === 'Long' ? entry - slDist : entry + slDist,
            takeProfit: direction === 'Long' ? entry + tpDist : entry - tpDist,
            slDistance: slDist, tpDistance: tpDist,
            regime: decision.regime, session: decision.session
          };
          entries++;
        }
      }
    }
  }

  return aggregate(symbol, candles.length - startIdx, entries, exitsTP, exitsSL, trades);
}

function aggregate(symbol, bars, entries, exitsTP, exitsSL, trades) {
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossW = wins.reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const netPnl = grossW - grossL;
  const wr = trades.length ? wins.length / trades.length : 0;
  const pf = grossL > 0 ? grossW / grossL : (grossW > 0 ? Infinity : 0);

  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) { equity += t.pnl; if (equity > peak) peak = equity; if (peak - equity > maxDD) maxDD = peak - equity; }

  return {
    symbol, bars, entries, trades: trades.length,
    wins: wins.length, losses: losses.length,
    winRate: wr, profitFactor: pf, netPnl,
    grossWin: grossW, grossLoss: grossL, maxDD, exitsTP, exitsSL,
    perRegime: groupBy(trades, t => `${t.session}_${t.regime}`),
    perYear:   groupBy(trades, t => t.year),
    allTrades: trades
  };
}

function groupBy(trades, keyFn) {
  const m = {};
  for (const t of trades) {
    const k = keyFn(t);
    if (!m[k]) m[k] = { trades: 0, wins: 0, pnl: 0 };
    m[k].trades++;
    if (t.pnl > 0) m[k].wins++;
    m[k].pnl += t.pnl;
  }
  return m;
}

// ─── Main ───
async function main() {
  const label = opts.days === 'ALL' ? 'FULL HISTORY (~3yr)' : `last ${opts.days} days`;
  console.log('================================================================');
  console.log(`  ANTIGRAVITY v2 — GATE ${opts.gate} BACKTEST — ${label}`);
  console.log('================================================================');
  console.log(`Symbols: ${opts.symbols.join(', ')}`);
  console.log(`Window:  trailing ${LIVE_BUFFER}-bar buffer (matches live)`);
  console.log(`Engine:  ${opts.gate === 2 ? 'gate2Engine.decide2 (pattern engine :3100)' : 'decisionEngine.decide (deployed GBDT bundles)'}`);
  console.log('');

  invalidateCache && invalidateCache();
  const startTime = Date.now();
  const results = [];

  for (const sym of opts.symbols) {
    process.stdout.write(`Backtesting ${sym} … `);
    const t0 = Date.now();
    const r = await simulateSymbol(sym, opts.gate);
    if (r.error) { console.log(`✗ ${r.error}`); continue; }
    console.log(`${r.trades} trades in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    results.push(r);
  }

  console.log('\n────────────────────────────────────────────────────────────────');
  console.log('  PER-SYMBOL RESULTS');
  console.log('────────────────────────────────────────────────────────────────');
  let gPnl = 0, gTrades = 0, gWins = 0, gGW = 0, gGL = 0;
  for (const r of results) {
    const pf = isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞';
    const pnl = (r.netPnl >= 0 ? '+$' : '-$') + Math.abs(r.netPnl).toFixed(0);
    console.log(`\n  ${r.symbol.replace('=F','')}  ────────────────────────────`);
    console.log(`    Trades:   ${r.trades}  (TP=${r.exitsTP} SL=${r.exitsSL})`);
    console.log(`    Win rate: ${(r.winRate*100).toFixed(1)}%   PF: ${pf}`);
    console.log(`    Net P&L:  ${pnl}   MaxDD: $${r.maxDD.toFixed(0)}`);
    console.log(`    Per year:`);
    for (const y of Object.keys(r.perYear).sort()) {
      const v = r.perYear[y];
      const subWR = v.trades ? (v.wins/v.trades*100).toFixed(0) : '—';
      console.log(`      ${y}:  ${String(v.trades).padStart(4)}t · WR ${subWR}% · ${v.pnl>=0?'+$':'-$'}${Math.abs(v.pnl).toFixed(0)}`);
    }
    console.log(`    Per regime:`);
    for (const k of Object.keys(r.perRegime).sort((a,b)=>r.perRegime[b].pnl-r.perRegime[a].pnl)) {
      const v = r.perRegime[k];
      const subWR = v.trades ? (v.wins/v.trades*100).toFixed(0) : '—';
      console.log(`      ${k.padEnd(26)} ${String(v.trades).padStart(4)}t · WR ${subWR}% · ${v.pnl>=0?'+$':'-$'}${Math.abs(v.pnl).toFixed(0)}`);
    }
    gPnl += r.netPnl; gTrades += r.trades; gWins += r.wins; gGW += r.grossWin; gGL += r.grossLoss;
  }

  console.log('\n================================================================');
  console.log('  GRAND TOTAL — ALL SYMBOLS');
  console.log('================================================================');
  console.log(`  Total trades:  ${gTrades}`);
  console.log(`  Win rate:      ${gTrades ? (gWins/gTrades*100).toFixed(1) : '—'}%`);
  console.log(`  Profit factor: ${gGL>0 ? (gGW/gGL).toFixed(2) : '∞'}`);
  console.log(`  Net P&L:       ${gPnl>=0?'+$':'-$'}${Math.abs(gPnl).toFixed(0)}  (1 contract, $4 RT comm)`);
  console.log(`  Elapsed:       ${((Date.now()-startTime)/1000).toFixed(1)}s`);

  // Persist full report (incl. all trades) for the auditor
  const outName = `backtest_gate${opts.gate}_${opts.days}_${Date.now()}.json`;
  const outPath = path.join(__dirname, '..', 'models', outName);
  fs.writeFileSync(outPath, JSON.stringify({
    generated: new Date().toISOString(),
    gate: opts.gate, windowDays: opts.days, symbols: opts.symbols,
    grandTotal: { trades: gTrades, wins: gWins, winRate: gTrades?gWins/gTrades:0,
                  profitFactor: gGL>0?gGW/gGL:0, netPnl: gPnl },
    perSymbol: results.map(r => ({ ...r, allTrades: undefined })),
    trades: results.flatMap(r => r.allTrades || [])
  }, null, 2));
  console.log(`\nSaved: models/${outName}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
