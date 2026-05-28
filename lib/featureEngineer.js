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

// Parse PT hour + minute + day-of-week from a CSV timestamp string.
// CSV timestamps carry explicit PT offset (-07:00 DST / -08:00 standard),
// so the H:MM in the string IS already PT local time.
function _parsePtComponents(ts) {
  let hour = 0, minute = 0, day = 0;
  if (typeof ts === 'string') {
    const m = ts.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
    if (m) {
      hour   = parseInt(m[4], 10);
      minute = parseInt(m[5], 10);
      day    = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getUTCDay();
    } else {
      const d = new Date(ts);
      hour   = d.getUTCHours();
      minute = d.getUTCMinutes();
      day    = d.getUTCDay();
    }
  } else {
    const d = new Date(ts);
    hour   = d.getUTCHours();
    minute = d.getUTCMinutes();
    day    = d.getUTCDay();
  }
  return { hour, minute, day };
}

// Instrument-aware RTH session boundaries (all in PT timezone, because that's
// what the CSV timestamps carry). ET = PT + 3 always (summer: PDT/EDT; winter: PST/EST).
//
//   NQ / ES (equity index): 6:30 AM–1:00 PM PT  (9:30 AM–4:00 PM ET, NYSE open→close)
//   CL (crude oil):         6:00 AM–11:30 AM PT  (9:00 AM–2:30 PM ET, NYMEX main session)
//   GC (gold):              5:20 AM–10:30 AM PT  (8:20 AM–1:30 PM ET, COMEX main session)
//
// symbol param is optional; defaults to equity-index boundaries for backward compat.
function sessionFromTimestamp(ts, symbol) {
  const { hour, minute, day } = _parsePtComponents(ts);
  const mins      = hour * 60 + minute;
  const isWeekday = day >= 1 && day <= 5;

  const fam = symbol ? symbol.replace('=F', '').replace('M', '').toUpperCase() : 'NQ';
  // Micro prefix removal: MNQ→NQ, MES→ES, MCL→CL, MGC→GC
  const cleanFam = fam.startsWith('M') && fam.length === 3 ? fam.slice(1) : fam;

  if (cleanFam === 'CL') {
    // NYMEX Crude Oil main session: 9:00 AM–2:30 PM ET = 6:00 AM–11:30 AM PT
    if (isWeekday && mins >= 360 && mins < 690) return 'RTH';
  } else if (cleanFam === 'GC') {
    // COMEX Gold main session: 8:20 AM–1:30 PM ET = 5:20 AM–10:30 AM PT
    if (isWeekday && mins >= 320 && mins < 630) return 'RTH';
  } else {
    // NQ / ES equity index: 9:30 AM–4:00 PM ET = 6:30 AM–1:00 PM PT (existing logic)
    if (isWeekday && mins >= 390 && mins < 780) return 'RTH';
  }
  return 'ETH';
}

// London session: 2:00 AM – 8:00 AM ET = 11:00 PM – 5:00 AM PT (crosses midnight).
// Critical for CL (London crude trading) and GC (London gold fix AM/PM).
// Returns 1 if we are in the London active window, 0 otherwise.
function _isLondonSession(hour, minute) {
  // ET = PT + 3; London active 2–8 AM ET = 11 PM–5 AM PT.
  // In PT: 0–5 AM (300 mins) OR 23:00+ (1380+ mins in 0–1439 range).
  const mins = hour * 60 + minute;
  return (mins < 300 || mins >= 1380) ? 1 : 0;
}

// ─── Public: build feature vector ────────────────────────────────────────────

// Builds a feature vector from a slice of candles up to (and including) the
// current bar. Returns an object {features, names, ts, session} where features
// is a Float32Array matching names index-by-index. Returns null if not enough
// history is available (so the trainer/inference skips this bar).
//
// opts.symbol — pass the instrument symbol (e.g. 'CL=F', 'GC=F', 'MNQ=F') so
//   the feature builder can use correct session boundaries and instrument-specific
//   features. Defaults to equity-index behavior when omitted (backward compat).
function buildFeatures(candles, opts = {}) {
  const symbol = opts.symbol || null;
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
  // Use symbol-aware session boundaries (CL/GC have different RTH windows)
  const session = sessionFromTimestamp(last.time, symbol);

  // ── Instrument-family flags ───────────────────────────────────────────────
  // Determine canonical 2-letter family (strip micro prefix 'M' and '=F')
  const _rawFam  = symbol ? symbol.replace('=F', '').toUpperCase() : 'NQ';
  const _fam     = (_rawFam.startsWith('M') && _rawFam.length === 3) ? _rawFam.slice(1) : _rawFam;
  const isEquity = (_fam === 'NQ' || _fam === 'ES') ? 1 : 0;
  const isCL     = (_fam === 'CL') ? 1 : 0;
  const isGC     = (_fam === 'GC') ? 1 : 0;

  // ── Day-of-week ───────────────────────────────────────────────────────────
  // Normalized 0–1: Mon=0.0, Tue=0.25, Wed=0.5, Thu=0.75, Fri=1.0
  // Useful for ALL instruments (e.g. CL Friday supply-squeeze, GC Monday positioning,
  // NQ/ES expiry Friday behavior). UTC day 0=Sun, 1=Mon…6=Sat.
  const { day: _dow } = _parsePtComponents(last.time);
  // Convert 1–5 (Mon–Fri) to 0.0–1.0 (non-weekdays get 0)
  const dayOfWeekNorm = (_dow >= 1 && _dow <= 5) ? (_dow - 1) / 4.0 : 0;

  // ── EIA inventory window (CL-specific) ───────────────────────────────────
  // EIA crude oil inventory is released every Wednesday at 10:30 AM ET (7:30 AM PT).
  // A ±90-minute window around the release creates the biggest weekly CL volatility
  // spike. Flag is 1 ONLY for CL/MCL on Wednesdays within that window.
  // Wednesday = UTC day 3.
  const { minute: _min } = _parsePtComponents(last.time);
  const ptMins  = hour * 60 + _min;
  // 7:30 AM PT = 450 min; ±90 min → 360–540 min
  const eiaWindow = (isCL && _dow === 3 && ptMins >= 360 && ptMins < 540) ? 1 : 0;

  // ── London session (CL + GC specific) ────────────────────────────────────
  // London active: 2:00–8:00 AM ET = 11:00 PM–5:00 AM PT (crosses midnight).
  // This is the most important non-RTH window for crude oil (ICE Brent activity)
  // and gold (London AM gold fix ~5:30 AM ET = 2:30 AM PT, PM fix ~10 AM ET).
  const londonSession = (isCL || isGC) ? _isLondonSession(hour, _min) : 0;

  const features = {
    // ── CORE 21 FEATURES (positions 0–20) ──────────────────────────────────
    // NEVER reorder or remove these — existing deployed models reference them by
    // positional index. New features must always be appended after this block.

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
    session_rth: session === 'RTH' ? 1 : 0,

    // ── INSTRUMENT-SPECIFIC FEATURES (positions 22+) ───────────────────────
    // Safe to add here: existing models trained before these features were added
    // only reference positions 0–21 via their stored split indices, so they
    // remain valid after a server restart. New models trained after this commit
    // will use all 27 features and benefit from the instrument context.

    // Family identity — helps model separate crude oil / gold seasonality from
    // equity-index intraday patterns even when trained across all symbols.
    is_equity_family: isEquity,       // 1 = NQ/ES/MNQ/MES
    is_cl_family:     isCL,           // 1 = CL/MCL
    is_gc_family:     isGC,           // 1 = GC/MGC

    // Day-of-week seasonality (useful for all instruments: Fri CL supply squeezes,
    // Wed EIA spike positioning, Mon GC safe-haven flows, Thu ES rollover activity)
    day_of_week_norm: dayOfWeekNorm,  // 0.0=Mon, 0.25=Tue, 0.5=Wed, 0.75=Thu, 1.0=Fri

    // CL-specific: EIA crude oil inventory window (Wed ±90 min of 10:30 AM ET)
    // For NQ/ES/GC this is always 0 — model learns to ignore it naturally.
    eia_window: eiaWindow,            // 1 = CL family, Wednesday, EIA release ±90 min

    // CL + GC London session flag (2–8 AM ET = London market hours)
    // Key for both: ICE Brent active, London Gold AM fix (5:30 AM ET), PM fix (10 AM ET)
    london_session: londonSession     // 1 = CL or GC within London active window
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
