// Antigravity v2 — Loss Auditor
// Replaces the old tradeAuditor.js that tuned on 3-trade samples (noise).
// On every closed trade: stores entry feature vector + model decision + outcome.
// When sample size reaches threshold per (symbol, session, regime, direction),
// flags retrain. Does NOT tune parameters reactively — retraining is the only
// way model behavior changes.

'use strict';

const fs = require('fs');
const path = require('path');

const ATTRIBUTIONS_FILE = path.join(__dirname, '..', 'models', 'loss_attributions.json');
const RETRAIN_TRIGGER_FILE = path.join(__dirname, '..', 'models', 'retrain_needed.json');

// Per-bucket min sample before retrain is suggested
const MIN_SAMPLE_FOR_RETRAIN = 50;
const RECENT_LOSS_WINDOW = 20;   // look at last N trades per bucket
const RECENT_LOSS_THRESHOLD = 0.70; // if >70% of last 20 lost → retrain flagged

function _load() {
  if (!fs.existsSync(ATTRIBUTIONS_FILE)) return { buckets: {}, schema: 2 };
  try {
    return JSON.parse(fs.readFileSync(ATTRIBUTIONS_FILE, 'utf-8'));
  } catch (e) {
    return { buckets: {}, schema: 2 };
  }
}

function _save(data) {
  const dir = path.dirname(ATTRIBUTIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ATTRIBUTIONS_FILE, JSON.stringify(data, null, 2));
}

function bucketKey(symbol, session, regime, direction) {
  return `${symbol}|${session}|${regime}|${direction}`;
}

// Record a closed trade for attribution.
// tradeRecord shape:
//   {
//     symbol, session, regime, direction,
//     entryTime, exitTime, entryPrice, exitPrice,
//     featureSnapshot: {name1: val1, ...},   // captured at entry
//     modelProbability: 0.72,
//     threshold: 0.65,
//     pnl: -120,                              // dollar P&L (negative = loss)
//     pnlR: -1.0,                             // R-multiple
//     exitReason: 'Stop Loss Triggered'
//   }
function recordTrade(tradeRecord) {
  const data = _load();
  const key = bucketKey(
    tradeRecord.symbol,
    tradeRecord.session,
    tradeRecord.regime,
    tradeRecord.direction
  );
  if (!data.buckets[key]) {
    data.buckets[key] = {
      symbol: tradeRecord.symbol,
      session: tradeRecord.session,
      regime: tradeRecord.regime,
      direction: tradeRecord.direction,
      trades: [],
      stats: { total: 0, wins: 0, losses: 0, netR: 0, lastReviewed: null }
    };
  }
  const bucket = data.buckets[key];
  bucket.trades.push(tradeRecord);
  bucket.stats.total++;
  if (tradeRecord.pnl > 0) bucket.stats.wins++; else bucket.stats.losses++;
  bucket.stats.netR += tradeRecord.pnlR || 0;

  // Cap trade history at 500 per bucket to avoid unbounded growth
  if (bucket.trades.length > 500) bucket.trades = bucket.trades.slice(-500);

  _save(data);

  return checkRetrainNeeded(bucket);
}

// Returns null if no retrain needed, or a reason object if it is.
function checkRetrainNeeded(bucket) {
  if (bucket.stats.total < MIN_SAMPLE_FOR_RETRAIN) return null;

  const recent = bucket.trades.slice(-RECENT_LOSS_WINDOW);
  if (recent.length < RECENT_LOSS_WINDOW) return null;

  const recentLosses = recent.filter(t => t.pnl <= 0).length;
  const lossRate = recentLosses / recent.length;

  if (lossRate >= RECENT_LOSS_THRESHOLD) {
    const flag = {
      bucket: bucketKey(bucket.symbol, bucket.session, bucket.regime, bucket.direction),
      reason: `recent loss rate ${(lossRate * 100).toFixed(0)}% over last ${RECENT_LOSS_WINDOW} trades`,
      flaggedAt: new Date().toISOString(),
      stats: { ...bucket.stats }
    };
    _writeRetrainFlag(flag);
    return flag;
  }

  return null;
}

function _writeRetrainFlag(flag) {
  let flags = [];
  if (fs.existsSync(RETRAIN_TRIGGER_FILE)) {
    try { flags = JSON.parse(fs.readFileSync(RETRAIN_TRIGGER_FILE, 'utf-8')); }
    catch (e) { flags = []; }
  }
  // Replace any existing flag for the same bucket
  flags = flags.filter(f => f.bucket !== flag.bucket);
  flags.push(flag);
  fs.writeFileSync(RETRAIN_TRIGGER_FILE, JSON.stringify(flags, null, 2));
}

// Feature attribution: which features had the highest magnitude at the entry
// of losing trades? Surfaces what the model is reading vs reality.
function topLossFeatures(symbol = null, limit = 10) {
  const data = _load();
  const tally = {};
  for (const [key, bucket] of Object.entries(data.buckets)) {
    if (symbol && bucket.symbol !== symbol) continue;
    for (const t of bucket.trades) {
      if (t.pnl > 0) continue;
      if (!t.featureSnapshot) continue;
      for (const [name, val] of Object.entries(t.featureSnapshot)) {
        if (!tally[name]) tally[name] = { count: 0, absSum: 0, signedSum: 0 };
        tally[name].count++;
        tally[name].absSum += Math.abs(val);
        tally[name].signedSum += val;
      }
    }
  }
  return Object.entries(tally)
    .map(([name, t]) => ({
      name,
      count: t.count,
      avgAbs: t.absSum / t.count,
      avgSigned: t.signedSum / t.count
    }))
    .sort((a, b) => b.avgAbs - a.avgAbs)
    .slice(0, limit);
}

function getBucketStats(symbol = null) {
  const data = _load();
  const out = [];
  for (const [key, bucket] of Object.entries(data.buckets)) {
    if (symbol && bucket.symbol !== symbol) continue;
    const recent = bucket.trades.slice(-RECENT_LOSS_WINDOW);
    out.push({
      bucket: key,
      symbol: bucket.symbol,
      session: bucket.session,
      regime: bucket.regime,
      direction: bucket.direction,
      total: bucket.stats.total,
      wins: bucket.stats.wins,
      losses: bucket.stats.losses,
      winRate: bucket.stats.total > 0 ? bucket.stats.wins / bucket.stats.total : 0,
      netR: bucket.stats.netR,
      recentWinRate: recent.length > 0
        ? recent.filter(t => t.pnl > 0).length / recent.length
        : 0,
      recentSize: recent.length
    });
  }
  return out;
}

function getRetrainFlags() {
  if (!fs.existsSync(RETRAIN_TRIGGER_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(RETRAIN_TRIGGER_FILE, 'utf-8')); }
  catch (e) { return []; }
}

function clearRetrainFlags() {
  if (fs.existsSync(RETRAIN_TRIGGER_FILE)) fs.unlinkSync(RETRAIN_TRIGGER_FILE);
}

module.exports = {
  recordTrade,
  topLossFeatures,
  getBucketStats,
  getRetrainFlags,
  clearRetrainFlags,
  bucketKey,
  MIN_SAMPLE_FOR_RETRAIN
};
