// Antigravity v2 — Regime Classifier
// Rule-based, deterministic. Takes a feature vector (from featureEngineer)
// and returns ONE of: TREND_UP, TREND_DOWN, CHOP, VOL_EXPANSION.
//
// CHOP regime = no trades (the bot's primary risk filter).
// Each non-chop regime maps to its own GBDT model file. One specialist per
// regime per session per symbol.

'use strict';

const REGIMES = ['TREND_UP', 'TREND_DOWN', 'CHOP', 'VOL_EXPANSION'];

// Tunable thresholds (auto-trainable later via grid search if desired)
const DEFAULT_THRESHOLDS = {
  adx_trend: 22,           // ADX below this = no trend
  bb_bandwidth_chop: 0.012, // BB bandwidth below this = squeeze/chop
  bb_bandwidth_expansion: 0.030, // Above this = vol expansion
  atr_percentile_expansion: 0.85,  // ATR in top 15% of recent = expansion
  ema_stack_threshold: 0.0005       // Min relative gap for "stacked" EMAs
};

function classifyRegime(featureVector, thresholds = DEFAULT_THRESHOLDS) {
  if (!featureVector) return { regime: 'CHOP', reason: 'no_features', confidence: 0 };

  const f = {};
  featureVector.names.forEach((n, i) => { f[n] = featureVector.values[i]; });

  const t = thresholds;

  // 1. Volatility expansion takes priority — big moves coming, gradient-boost
  //    models trained on the VOL_EXPANSION subset specialize in breakout/fade
  if (f.atr_percentile >= t.atr_percentile_expansion ||
      f.bb_bandwidth >= t.bb_bandwidth_expansion) {
    return {
      regime: 'VOL_EXPANSION',
      reason: `atr_pct=${f.atr_percentile.toFixed(2)} bb_bw=${f.bb_bandwidth.toFixed(4)}`,
      confidence: Math.min(1, f.atr_percentile)
    };
  }

  // 2. Chop / squeeze — no edge, sit out
  if (f.adx < t.adx_trend && f.bb_bandwidth < t.bb_bandwidth_chop) {
    return {
      regime: 'CHOP',
      reason: `adx=${f.adx.toFixed(1)} bb_bw=${f.bb_bandwidth.toFixed(4)} (squeeze)`,
      confidence: 1 - f.adx / t.adx_trend
    };
  }

  // 3. Trend regimes — require EMA stack alignment + ADX above floor
  const emaStackUp = f.ema9_21_gap > t.ema_stack_threshold &&
                     f.ema21_50_gap > t.ema_stack_threshold &&
                     f.ema50_dist > 0;
  const emaStackDown = f.ema9_21_gap < -t.ema_stack_threshold &&
                       f.ema21_50_gap < -t.ema_stack_threshold &&
                       f.ema50_dist < 0;

  if (f.adx >= t.adx_trend && emaStackUp) {
    return {
      regime: 'TREND_UP',
      reason: `adx=${f.adx.toFixed(1)} stack_up`,
      confidence: Math.min(1, f.adx / 40)
    };
  }
  if (f.adx >= t.adx_trend && emaStackDown) {
    return {
      regime: 'TREND_DOWN',
      reason: `adx=${f.adx.toFixed(1)} stack_down`,
      confidence: Math.min(1, f.adx / 40)
    };
  }

  // 4. Default fallback — no clean regime → treat as chop
  return {
    regime: 'CHOP',
    reason: `adx=${f.adx.toFixed(1)} mixed (no clean regime)`,
    confidence: 0.3
  };
}

// Maps a regime to whether trading is allowed at all
function isTradeable(regime) {
  return regime !== 'CHOP';
}

// Builds the model key used to look up the right GBDT file:
//   models/{symbol}_{session}_{regime}.json
// Example: models/NQ=F_RTH_TREND_UP.json
function modelKey(symbol, session, regime) {
  return `${symbol}_${session}_${regime}`;
}

module.exports = {
  classifyRegime,
  isTradeable,
  modelKey,
  REGIMES,
  DEFAULT_THRESHOLDS
};
