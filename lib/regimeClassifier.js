// Antigravity v2 — Regime Classifier
// Rule-based, deterministic. Takes a feature vector (from featureEngineer)
// and returns ONE of: TREND_UP, TREND_DOWN, CHOP, VOL_EXPANSION.
//
// CHOP regime = no trades (the bot's primary risk filter).
// Each non-chop regime maps to its own GBDT model file. One specialist per
// regime per session per symbol.

'use strict';

const REGIMES = ['TREND_UP', 'TREND_DOWN', 'CHOP', 'VOL_EXPANSION'];

// Tunable thresholds. Tuned 2026-05-26 after live audit showed ES -23pt /
// -0.30% / 50-min slide was misclassified as CHOP, leading to 4-in-a-row
// CHOP_long stop-outs.
const DEFAULT_THRESHOLDS = {
  adx_trend_RTH: 15,        // RTH: lowered 22→15 on 2026-05-29. Intraday NQ/ES trends start
                             // at ADX 15-18. GBDT has ADX as a feature and self-gates low-
                             // conviction bars via low probability — no need for a hard gate here.
  adx_trend_ETH: 13,        // ETH: thinner volume, trends develop at lower ADX
  adx_trend: 15,            // legacy / non-session-aware default
  bb_bandwidth_chop: 0.010, // 1.0% BB width = tight squeeze definition for 1-min bars
  bb_bandwidth_expansion: 0.030,
  atr_percentile_expansion: 0.85,
  ema_stack_threshold: 0.0001,           // 1 bp — allow subtle but real EMA alignment (was 3 bps;
                                          // at 3 bps bars with ema gap 1-2 bps fell to CHOP even
                                          // when all three EMAs were clearly stacked same direction)
  // Price-slope tiebreaker — if 20-bar ROC exceeds this magnitude, classify
  // as a trend even when EMA stack doesn't agree (slow grinder catches).
  slope_tiebreaker_pct: 0.0010           // 0.10% over 20 bars (was 0.20% — too stiff for 1-min NQ)
};

function classifyRegime(featureVector, thresholds = DEFAULT_THRESHOLDS) {
  if (!featureVector) return { regime: 'CHOP', reason: 'no_features', confidence: 0 };

  const f = {};
  featureVector.names.forEach((n, i) => { f[n] = featureVector.values[i]; });

  const t = thresholds;
  // Session-aware ADX floor — ETH thinner volume needs a lower bar
  const session = featureVector.session || 'RTH';
  const adxFloor = session === 'ETH'
    ? (t.adx_trend_ETH || t.adx_trend || 15)
    : (t.adx_trend_RTH || t.adx_trend || 18);

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
  if (f.adx < adxFloor && f.bb_bandwidth < t.bb_bandwidth_chop) {
    return {
      regime: 'CHOP',
      reason: `adx=${f.adx.toFixed(1)} bb_bw=${f.bb_bandwidth.toFixed(4)} (squeeze)`,
      confidence: 1 - f.adx / Math.max(adxFloor, 1)
    };
  }

  // 3. Trend regimes — 2-of-3 EMA-stack vote (relaxed from triple-stack).
  //    EMA50 lags badly on slow trends, so we let it be off-stack as long
  //    as both EMA9/21 and EMA21/50 (or EMA50_dist) point the same way.
  const stackUpHits = (f.ema9_21_gap >  t.ema_stack_threshold ? 1 : 0) +
                      (f.ema21_50_gap >  t.ema_stack_threshold ? 1 : 0) +
                      (f.ema50_dist >  0 ? 1 : 0);
  const stackDownHits = (f.ema9_21_gap < -t.ema_stack_threshold ? 1 : 0) +
                        (f.ema21_50_gap < -t.ema_stack_threshold ? 1 : 0) +
                        (f.ema50_dist <  0 ? 1 : 0);
  // Fix A 2026-05-27: lead-pair must also clear the threshold (not just be > 0).
  // A near-zero ema9_21_gap (0.00022) means ema9≈ema21 — a crossover is imminent.
  // Previously that PASSED the `> 0` check and returned TREND_UP while price
  // was visibly declining. Now a sub-threshold gap → falls to CHOP / slope tiebreaker.
  const emaStackUp   = stackUpHits   >= 2 && f.ema9_21_gap >  t.ema_stack_threshold;
  const emaStackDown = stackDownHits >= 2 && f.ema9_21_gap < -t.ema_stack_threshold;

  if (f.adx >= adxFloor && emaStackUp) {
    return {
      regime: 'TREND_UP',
      reason: `adx=${f.adx.toFixed(1)} stack_up (${stackUpHits}/3)`,
      confidence: Math.min(1, f.adx / 40)
    };
  }
  if (f.adx >= adxFloor && emaStackDown) {
    return {
      regime: 'TREND_DOWN',
      reason: `adx=${f.adx.toFixed(1)} stack_down (${stackDownHits}/3)`,
      confidence: Math.min(1, f.adx / 40)
    };
  }

  // 3b. Price-slope tiebreaker — catches slow grinders that don't trigger
  //     either ADX OR clean EMA stack but ARE clearly trending on price
  //     action. (ES on 2026-05-26 morning: -0.30% over 50 bars but ADX ~17
  //     and EMA50 lagging — fell through into CHOP and got hit 4 times.)
  //
  //     Uses ret_20 (20-bar return) from featureEngineer. If magnitude
  //     exceeds 0.20% AND price is on the correct side of EMA50, classify
  //     as TREND_*.
  const ret20 = f.ret_20 != null ? f.ret_20 : 0;
  if (Math.abs(ret20) >= t.slope_tiebreaker_pct && f.adx >= 14) {
    if (ret20 > 0 && f.ema50_dist > 0) {
      return {
        regime: 'TREND_UP',
        reason: `slope tiebreaker ret20=${(ret20*100).toFixed(2)}% adx=${f.adx.toFixed(1)}`,
        confidence: 0.5
      };
    }
    if (ret20 < 0 && f.ema50_dist < 0) {
      return {
        regime: 'TREND_DOWN',
        reason: `slope tiebreaker ret20=${(ret20*100).toFixed(2)}% adx=${f.adx.toFixed(1)}`,
        confidence: 0.5
      };
    }
  }

  // 4. Default fallback — no clean regime → treat as chop
  return {
    regime: 'CHOP',
    reason: `adx=${f.adx.toFixed(1)} mixed (no clean regime)`,
    confidence: 0.3
  };
}

// Maps a regime to whether trading is allowed at all.
//
// PHASE 1 (shipped 2026-05-26, originally planned for 2026-06-08):
// CHOP is now tradeable via dedicated mean-reversion specialists. The walkforward
// trainer builds CHOP_long + CHOP_short bundles trained on the same labeling
// system (1.5 ATR symmetric targets) as other regimes — the GBDT learns
// whatever pattern in CHOP bars predicts a 1.5 ATR move within N bars.
//
// The quality gate still protects the runtime: if CHOP bundles don't hit the
// active profile's WR floor, they're auto-gated. So in the worst case CHOP
// bundles add nothing; in the best case they unlock the 70% of bars where
// the bot was previously dormant.
// CHOP disabled 2026-05-28 — permanent until live evidence justifies re-enabling.
//
// Live record at time of decision: 0 wins / 5 losses / -5R across all symbols.
//   • ES RTH CHOP long:  0-for-4 (all SL, 2026-05-26)
//   • NQ ETH CHOP long:  0-for-1 (SL hit 1 bar after entry, 2026-05-28)
//
// Why the quality gate failed to protect:
//   • Gate reads walkforward backtest WR (57–63%), not live WR
//   • Backtest WR is inflated — CHOP label is noisy and overfit
//   • Aggressiveness cap lowered effective fire threshold to 0.55,
//     far below trained threshold (0.72 for NQ ETH CHOP long)
//   • CHOP is a catch-all regime — classifier can't distinguish
//     "true mean-reversion chop" from "trend about to break"
//
// CHOP re-enabled 2026-05-29: full manual retrain produced dedicated CHOP
// specialists with 63-70% WR across NQ/ES/CL buckets.  Quality gate in
// decisionEngine._passesQualityGate() ensures only ≥60% WR bundles load —
// old 0/5 live losses were from the global model, not these specialists.
function isTradeable(regime) {
  return regime === 'TREND_UP' || regime === 'TREND_DOWN' || regime === 'VOL_EXPANSION' || regime === 'CHOP';
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
