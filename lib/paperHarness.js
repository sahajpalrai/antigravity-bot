// Antigravity v2 — Paper trade harness
// Runs the decision engine against live NT8 bar pushes but does NOT send
// orders to NT8. Logs paper trades to paper_trades.json so the user can
// validate model performance for 30 days before going live.

'use strict';

const fs = require('fs');
const path = require('path');

const PAPER_FILE = path.join(__dirname, '..', 'models', 'paper_trades.json');

// Per-symbol simulated state
const _paperState = {
  'NQ=F': null, 'ES=F': null, 'CL=F': null, 'GC=F': null
};

const CONTRACT_SPECS = {
  'NQ=F': { tickSize: 0.25, pointVal: 20, comm: 4 },
  'ES=F': { tickSize: 0.25, pointVal: 50, comm: 4 },
  'CL=F': { tickSize: 0.01, pointVal: 1000, comm: 4 },
  'GC=F': { tickSize: 0.10, pointVal: 100, comm: 4 }
};

function _load() {
  if (!fs.existsSync(PAPER_FILE)) return { trades: [], openPositions: {} };
  try { return JSON.parse(fs.readFileSync(PAPER_FILE, 'utf-8')); }
  catch (e) { return { trades: [], openPositions: {} }; }
}

function _save(data) {
  const dir = path.dirname(PAPER_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PAPER_FILE, JSON.stringify(data, null, 2));
}

// Called for each new bar with the decision engine's output and current candle.
function onBarDecision(symbol, decision, currentCandle) {
  const spec = CONTRACT_SPECS[symbol];
  if (!spec) return;
  const data = _load();
  data.openPositions = data.openPositions || {};
  const open = data.openPositions[symbol];

  // 1. If we have an open paper position, check stop/target hit on this bar
  if (open) {
    const c = currentCandle;
    let hit = null;
    if (open.direction === 'Long') {
      if (c.low <= open.stopLoss) hit = { px: open.stopLoss, reason: 'SL' };
      else if (c.high >= open.takeProfit) hit = { px: open.takeProfit, reason: 'TP' };
    } else {
      if (c.high >= open.stopLoss) hit = { px: open.stopLoss, reason: 'SL' };
      else if (c.low <= open.takeProfit) hit = { px: open.takeProfit, reason: 'TP' };
    }
    if (hit) {
      const priceDiff = hit.px - open.entryPrice;
      const points = priceDiff * (open.direction === 'Long' ? 1 : -1);
      const grossPnl = points * spec.pointVal * open.qty;
      const netPnl = grossPnl - spec.comm * open.qty;
      const closed = {
        ...open,
        exitTime: c.time,
        exitPrice: hit.px,
        exitReason: hit.reason,
        pnl: netPnl,
        pnlR: open.slDistance > 0 ? points / open.slDistance : 0
      };
      data.trades.push(closed);
      if (data.trades.length > 2000) data.trades = data.trades.slice(-2000);
      data.openPositions[symbol] = null;
      _save(data);
      return { event: 'close', trade: closed };
    }
  }

  // 2. No open position — consider entry
  if (!open && (decision.action === 'BUY' || decision.action === 'SELL')) {
    const direction = decision.action === 'BUY' ? 'Long' : 'Short';
    const entry = currentCandle.close;
    const slDist = decision.slDistance;
    const tpDist = decision.tpDistance;
    const stopLoss = direction === 'Long' ? entry - slDist : entry + slDist;
    const takeProfit = direction === 'Long' ? entry + tpDist : entry - tpDist;
    const position = {
      symbol,
      direction,
      qty: 1,                        // paper always 1 contract for clean R measurement
      entryPrice: entry,
      stopLoss,
      takeProfit,
      slDistance: slDist,
      tpDistance: tpDist,
      entryTime: currentCandle.time,
      regime: decision.regime,
      session: decision.session,
      probability: decision.probability,
      threshold: decision.threshold
    };
    data.openPositions[symbol] = position;
    _save(data);
    return { event: 'open', position };
  }

  return null;
}

function getPaperState() {
  return _load();
}

function getRecentTrades(limit = 50) {
  const data = _load();
  return data.trades.slice(-limit).reverse();
}

function getStats() {
  const data = _load();
  const trades = data.trades;
  if (trades.length === 0) {
    return { total: 0, wins: 0, losses: 0, winRate: 0, netR: 0, totalPnl: 0 };
  }
  let wins = 0, totalPnl = 0, totalR = 0;
  for (const t of trades) {
    if (t.pnl > 0) wins++;
    totalPnl += t.pnl;
    totalR += t.pnlR || 0;
  }
  return {
    total: trades.length,
    wins,
    losses: trades.length - wins,
    winRate: wins / trades.length,
    netR: totalR,
    totalPnl,
    avgPnl: totalPnl / trades.length
  };
}

function getStatsByRegime() {
  const data = _load();
  const buckets = {};
  for (const t of data.trades) {
    const key = `${t.symbol}|${t.session}|${t.regime}|${t.direction}`;
    if (!buckets[key]) buckets[key] = { trades: 0, wins: 0, pnl: 0 };
    buckets[key].trades++;
    if (t.pnl > 0) buckets[key].wins++;
    buckets[key].pnl += t.pnl;
  }
  return Object.entries(buckets).map(([k, b]) => ({
    bucket: k,
    trades: b.trades,
    wins: b.wins,
    winRate: b.trades > 0 ? b.wins / b.trades : 0,
    pnl: b.pnl
  })).sort((a, b) => b.trades - a.trades);
}

module.exports = {
  onBarDecision,
  getPaperState,
  getRecentTrades,
  getStats,
  getStatsByRegime
};
