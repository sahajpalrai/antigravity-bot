// Antigravity v2 — Live Decision Engine
// Brings everything together: a stream of candles in → BUY / SELL / FLAT signal out.
// Loads trained GBDT models from models/ folder, runs feature extraction →
// regime classification → routed model prediction → threshold gating →
// position sizing → exit levels.

'use strict';

const fs = require('fs');
const path = require('path');
const { buildFeatures, sessionFromTimestamp } = require('./featureEngineer');
const { classifyRegime, isTradeable } = require('./regimeClassifier');
const { predict, deserialize } = require('./gbdtModel');

const MODELS_DIR = path.join(__dirname, '..', 'models');

// Quality gate — bundles whose walkforward aggregate fails these thresholds are
// auto-refused at load time. Configurable via env. Protects against the
// "ES_RTH_TREND_UP_long 28% WR / PF 0.69" disaster being deployed by accident.
const QUALITY_MIN_WR = parseFloat(process.env.MIN_WR || '0.55');
const QUALITY_MIN_PF = parseFloat(process.env.MIN_PF || '1.5');
const QUALITY_MIN_TRADES = parseInt(process.env.MIN_TRADES || '30', 10);

function _passesQualityGate(agg) {
  if (!agg) return false;
  if ((agg.totalTestTrades || 0) < QUALITY_MIN_TRADES) return false;
  if ((agg.winRate || 0) < QUALITY_MIN_WR) return false;
  if ((agg.profitFactor || 0) < QUALITY_MIN_PF) return false;
  return true;
}

// In-memory model cache
const _modelCache = new Map();
let _lastCacheRefresh = 0;
const CACHE_TTL_MS = 60 * 1000;

function _modelPath(symbol, session, regime, direction) {
  const sym = symbol.replace('=F', '');
  return path.join(MODELS_DIR, `${sym}_${session}_${regime}_${direction}.json`);
}

function _loadModel(symbol, session, regime, direction) {
  const key = `${symbol}|${session}|${regime}|${direction}`;
  const cached = _modelCache.get(key);
  if (cached && (Date.now() - cached.loadedAt) < CACHE_TTL_MS) return cached;

  const file = _modelPath(symbol, session, regime, direction);
  if (!fs.existsSync(file)) {
    _modelCache.set(key, { missing: true, loadedAt: Date.now() });
    return _modelCache.get(key);
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const obj = JSON.parse(raw);

    // Quality gate — refuse to load bundles below the bar so the live engine
    // never trades a known-bad specialist (e.g., ES_RTH_TREND_UP_long 28% WR).
    const passes = _passesQualityGate(obj.aggregate);
    if (!passes) {
      const entry = {
        missing: false,
        disabled: true,
        reason: 'failed quality gate',
        aggregate: obj.aggregate || null,
        threshold: obj.threshold || 0.65,
        loadedAt: Date.now()
      };
      _modelCache.set(key, entry);
      return entry;
    }

    const model = deserialize(obj);
    const entry = {
      model,
      threshold: obj.threshold || 0.65,
      aggregate: obj.aggregate || null,
      loadedAt: Date.now()
    };
    _modelCache.set(key, entry);
    return entry;
  } catch (e) {
    console.error(`[DecisionEngine] Failed to load model ${file}: ${e.message}`);
    _modelCache.set(key, { missing: true, error: e.message, loadedAt: Date.now() });
    return _modelCache.get(key);
  }
}

function invalidateCache() {
  _modelCache.clear();
  _lastCacheRefresh = 0;
}

// ─── Public: produce a decision from a candle window ─────────────────────────
//
// Returns one of:
//   { action: 'FLAT', reason: '...', regime, session }
//   { action: 'BUY' | 'SELL', symbol, probability, threshold, regime, session,
//     atr, close, tpDistance, slDistance, featureSnapshot }

function decide(symbol, candles, opts = {}) {
  const fv = buildFeatures(candles);
  if (!fv) return { action: 'FLAT', reason: 'insufficient_history' };

  const regimeInfo = classifyRegime(fv);
  if (!isTradeable(regimeInfo.regime)) {
    return {
      action: 'FLAT',
      reason: `regime=${regimeInfo.regime} (${regimeInfo.reason})`,
      regime: regimeInfo.regime,
      session: fv.session
    };
  }

  // Run both LONG and SHORT specialists and pick the higher-conviction side
  const longEntry = _loadModel(symbol, fv.session, regimeInfo.regime, 'long');
  const shortEntry = _loadModel(symbol, fv.session, regimeInfo.regime, 'short');

  const longUsable = longEntry && !longEntry.missing && !longEntry.disabled;
  const shortUsable = shortEntry && !shortEntry.missing && !shortEntry.disabled;

  if (!longUsable && !shortUsable) {
    const why = longEntry.disabled || shortEntry.disabled
      ? `bundle(s) disabled by quality gate for ${fv.session}/${regimeInfo.regime}`
      : `no models trained for ${fv.session}/${regimeInfo.regime}`;
    return {
      action: 'FLAT',
      reason: why,
      regime: regimeInfo.regime,
      session: fv.session,
      longBundle: longEntry.disabled ? 'DISABLED' : (longEntry.missing ? 'MISSING' : 'OK'),
      shortBundle: shortEntry.disabled ? 'DISABLED' : (shortEntry.missing ? 'MISSING' : 'OK')
    };
  }

  let longProb = 0, shortProb = 0;
  let longTh = 0.65, shortTh = 0.65;
  if (longUsable) {
    longProb = predict(longEntry.model, fv.values);
    longTh = longEntry.threshold;
  }
  if (shortUsable) {
    shortProb = predict(shortEntry.model, fv.values);
    shortTh = shortEntry.threshold;
  }

  // Build feature snapshot for the loss auditor
  const featureSnapshot = {};
  fv.names.forEach((n, i) => { featureSnapshot[n] = fv.values[i]; });

  // Only allow signals from usable bundles — disabled ones never fire
  const longSignal = longUsable && longProb >= longTh;
  const shortSignal = shortUsable && shortProb >= shortTh;

  // R:R configuration (matches walkforward backtest assumptions)
  const tpR = opts.tpR || 1.8;
  const slR = opts.slR || 1.0;
  const slAtrMult = 1.5;       // SL is 1.5 ATR away (matches symmetric label barrier)
  const tpAtrMult = 1.5 * tpR / slR;  // TP is 2.7 ATR away → 1.8:1 R:R

  // Conflict resolution: if both fire, take the higher (prob - threshold) margin
  if (longSignal && shortSignal) {
    if ((longProb - longTh) >= (shortProb - shortTh)) {
      return _buildEntry('BUY', symbol, fv, longProb, longTh, regimeInfo, slAtrMult, tpAtrMult, featureSnapshot);
    } else {
      return _buildEntry('SELL', symbol, fv, shortProb, shortTh, regimeInfo, slAtrMult, tpAtrMult, featureSnapshot);
    }
  }
  if (longSignal) return _buildEntry('BUY', symbol, fv, longProb, longTh, regimeInfo, slAtrMult, tpAtrMult, featureSnapshot);
  if (shortSignal) return _buildEntry('SELL', symbol, fv, shortProb, shortTh, regimeInfo, slAtrMult, tpAtrMult, featureSnapshot);

  return {
    action: 'FLAT',
    reason: `below threshold (long=${longProb.toFixed(2)}<${longTh}, short=${shortProb.toFixed(2)}<${shortTh})`,
    regime: regimeInfo.regime,
    session: fv.session,
    probabilities: { long: longProb, short: shortProb, longTh, shortTh }
  };
}

function _buildEntry(action, symbol, fv, prob, threshold, regimeInfo, slAtrMult, tpAtrMult, snapshot) {
  return {
    action,
    symbol,
    probability: prob,
    threshold,
    regime: regimeInfo.regime,
    session: fv.session,
    atr: fv.atr,
    close: fv.close,
    slDistance: fv.atr * slAtrMult,
    tpDistance: fv.atr * tpAtrMult,
    breakevenDistance: fv.atr * 0.8,  // move SL to entry at 0.8 ATR profit
    trailingDistance: fv.atr * 1.2,   // start trailing at 1.2 ATR profit
    featureSnapshot: snapshot,
    timestamp: fv.ts
  };
}

// Returns a snapshot of every available model for the dashboard.
// `enabled` reflects the quality gate — disabled bundles are listed but
// the live decision engine refuses to fire them.
function modelStatus() {
  if (!fs.existsSync(MODELS_DIR)) return [];
  const files = fs.readdirSync(MODELS_DIR).filter(f =>
    f.endsWith('.json') &&
    !f.includes('latest_report') &&
    !f.includes('loss_attributions') &&
    !f.includes('retrain_needed') &&
    !f.includes('paper_trades')
  );
  return files.map(f => {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, f), 'utf-8'));
      const enabled = _passesQualityGate(obj.aggregate);
      return {
        file: f,
        symbol: obj.symbol,
        session: obj.session,
        regime: obj.regime,
        direction: obj.direction,
        threshold: obj.threshold,
        aggregate: obj.aggregate,
        trainedAt: obj.trained,
        enabled,
        gateReason: enabled ? null : _gateRejectReason(obj.aggregate)
      };
    } catch (e) {
      return { file: f, error: e.message, enabled: false };
    }
  });
}

function _gateRejectReason(agg) {
  if (!agg) return 'no aggregate metrics';
  const reasons = [];
  if ((agg.totalTestTrades || 0) < QUALITY_MIN_TRADES) reasons.push(`trades<${QUALITY_MIN_TRADES}`);
  if ((agg.winRate || 0) < QUALITY_MIN_WR) reasons.push(`WR<${(QUALITY_MIN_WR*100).toFixed(0)}%`);
  if ((agg.profitFactor || 0) < QUALITY_MIN_PF) reasons.push(`PF<${QUALITY_MIN_PF}`);
  return reasons.join(', ');
}

module.exports = {
  decide,
  modelStatus,
  invalidateCache
};
