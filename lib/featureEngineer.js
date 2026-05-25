// Antigravity v2 — Feature Engineering
// Pure functions, no I/O, fully deterministic. Converts raw OHLCV candles into
// a fixed-length feature vector for the GBDT model. Same code path runs in
// training (offline) and inference (live).

'use strict';

// ─── Indicator primitives ────────────────────────────────────────────────────

function sma(values, period) {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += values[i];
  e /= period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function emaSeries(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += values[i];
  e /= period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function stdev(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gain += diff;
    else loss -= diff;
  }
  gain /= period;
  loss /= period;
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);
  const macdLine = fastSeries.map((v, i) => v - slowSeries[i]);
  const validStart = macdLine.findIndex(v => !isNaN(v));
  if (validStart === -1) return null;
  const cleanMacd = macdLine.slice(validStart);
  const signalSeries = emaSeries(cleanMacd, signal);
  const lastSignal = signalSeries[signalSeries.length - 1];
  const lastMacd = macdLine[macdLine.length - 1];
  if (isNaN(lastSignal) || isNaN(lastMacd)) return null;
  return { macd: lastMacd, signal: lastSignal, hist: lastMacd - lastSignal };
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

function bollinger(closes, period = 20, mult = 2.0) {
  const mid = sma(closes, period);
  const sd = stdev(closes, period);
  if (mid === null || sd === null) return null;
  return {
    mid, sd,
    upper: mid + mult * sd,
    lower: mid - mult * sd,
    bandwidth: (2 * mult * sd) / mid,
    z: (closes[closes.length - 1] - mid) / sd
  };
}

function adx(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  // Wilder smoothing
  let atrSum = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDMSum = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDMSum = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  const dxValues = [];
  for (let i = period; i < tr.length; i++) {
    atrSum = atrSum - atrSum / period + tr[i];
    plusDMSum = plusDMSum - plusDMSum / period + plusDM[i];
    minusDMSum = minusDMSum - minusDMSum / period + minusDM[i];
    const plusDI = 100 * plusDMSum / atrSum;
    const minusDI = 100 * minusDMSum / atrSum;
    const dx = 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);
    dxValues.push(dx);
  }
  if (dxValues.length < period) return null;
  return dxValues.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function quantile(arr, q) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

// ─── Time helpers ────────────────────────────────────────────────────────────

// Returns hour-of-day in PT timezone for a candle. The CSV timestamps already
// carry a -07:00/-08:00 offset; we strip it and use local hour.
function ptHourFromTimestamp(ts) {
  if (typeof ts === 'string') {
    // "2023-05-23 22:05:00-07:00" → 22
    const m = ts.match(/(\d{2}):\d{2}:\d{2}/);
    if (m) return parseInt(m[1], 10);
  }
  const d = new Date(ts);
  return d.getUTCHours(); // fallback
}

// RTH = 6:30am-1:00pm PT (Mon-Fri). Everything else = ETH.
function sessionFromTimestamp(ts) {
  let hour, minute, day;
  if (typeof ts === 'string') {
    const m = ts.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
    if (m) {
      hour = parseInt(m[4], 10);
      minute = parseInt(m[5], 10);
      day = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getUTCDay();
    } else {
      const d = new Date(ts);
      hour = d.getUTCHours();
      minute = d.getUTCMinutes();
      day = d.getUTCDay();
    }
  } else {
    const d = new Date(ts);
    hour = d.getUTCHours();
    minute = d.getUTCMinutes();
    day = d.getUTCDay();
  }
  const mins = hour * 60 + minute;
  const isWeekday = day >= 1 && day <= 5;
  if (isWeekday && mins >= 390 && mins < 780) return 'RTH';
  return 'ETH';
}

// ─── Public: build feature vector ────────────────────────────────────────────

// Builds a feature vector from a slice of candles up to (and including) the
// current bar. Returns an object {features, names, ts, session} where features
// is a Float32Array matching names index-by-index. Returns null if not enough
// history is available (so the trainer/inference skips this bar).
function buildFeatures(candles, opts = {}) {
  const MIN_BARS = 220; // need 200 EMA + buffer
  if (candles.length < MIN_BARS) return null;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const vols = candles.map(c => c.volume || 0);
  const last = candles[candles.length - 1];

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const r = rsi(closes, 14);
  const m = macd(closes, 12, 26, 9);
  const a = atr(candles, 14);
  const bb = bollinger(closes, 20, 2.0);
  const ax = adx(candles, 14);

  if ([ema9, ema21, ema50, ema200, r, a].some(v => v === null) || !m || !bb) return null;
  // adx can be null on tight windows — fall back to 20 (no trend signal)
  const adxVal = ax === null ? 20 : ax;

  // ATR percentile over last 100 bars (volatility regime indicator)
  const recentATRs = [];
  for (let i = candles.length - 100; i < candles.length; i++) {
    if (i < 15) continue;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    recentATRs.push(tr);
  }
  const atrPercentile = recentATRs.length > 0
    ? recentATRs.filter(v => v <= a).length / recentATRs.length
    : 0.5;

  // Volume z-score over last 50 bars
  const recentVols = vols.slice(-50);
  const volMean = recentVols.reduce((s, v) => s + v, 0) / recentVols.length;
  const volSd = Math.sqrt(recentVols.reduce((s, v) => s + (v - volMean) ** 2, 0) / recentVols.length) || 1;
  const volZ = (last.volume - volMean) / volSd;

  // Returns over multiple horizons (normalized)
  const ret1 = (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2];
  const ret5 = (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6];
  const ret20 = (closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21];

  // Candle body / wick ratios (price-action signal)
  const range = last.high - last.low || 1;
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const bodyRatio = body / range;
  const wickAsym = (upperWick - lowerWick) / range;

  // Time-of-day buckets (one-hot-ish — keep as scalar for tree models)
  const hour = ptHourFromTimestamp(last.time);
  const session = sessionFromTimestamp(last.time);

  const features = {
    // Trend
    ema9_dist:   (last.close - ema9) / last.close,
    ema21_dist:  (last.close - ema21) / last.close,
    ema50_dist:  (last.close - ema50) / last.close,
    ema200_dist: (last.close - ema200) / last.close,
    ema9_21_gap: (ema9 - ema21) / last.close,
    ema21_50_gap: (ema21 - ema50) / last.close,

    // Momentum
    rsi: r,
    macd_hist: m.hist,
    macd_line: m.macd,
    adx: adxVal,

    // Volatility
    atr_pct: a / last.close,
    atr_percentile: atrPercentile,
    bb_z: bb.z,
    bb_bandwidth: bb.bandwidth,

    // Volume
    vol_z: volZ,

    // Returns
    ret_1: ret1,
    ret_5: ret5,
    ret_20: ret20,

    // Price-action shape
    body_ratio: bodyRatio,
    wick_asym: wickAsym,

    // Time
    hour_of_day: hour,
    session_rth: session === 'RTH' ? 1 : 0
  };

  const names = Object.keys(features);
  const values = names.map(n => features[n]);

  return {
    names,
    values,
    ts: last.time,
    session,
    atr: a,
    close: last.close
  };
}

module.exports = {
  buildFeatures,
  sessionFromTimestamp,
  // Re-export primitives for testing
  ema, sma, rsi, macd, atr, bollinger, adx, stdev, quantile, emaSeries
};
