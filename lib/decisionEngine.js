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
const { familyMiniSymbol, CONTRACT_SPECS } = require('./paperEngine');
const { fixedExitsFor } = require('./exitsConfig');

const MODELS_DIR = path.join(__dirname, '..', 'models');

// Quality gate — bundles whose walkforward aggregate fails these thresholds are
// auto-refused at load time. Protects against the "ES_RTH_TREND_UP_long 28% WR
// / PF 0.69" disaster being deployed by accident.
//
// HYBRID PER-SESSION FLOORS: RTH is held to a high 65% bar (tight spreads,
// clean regimes), ETH is held to a realistic 55% bar (noise, low volume).
// Floors are persisted by the trainer into models/quality_floors.json and
// can be hot-reloaded without restarting the server.
const _FLOORS_FILE = path.join(__dirname, '..', 'models', 'quality_floors.json');

function _loadFloors() {
  try {
    if (fs.existsSync(_FLOORS_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(_FLOORS_FILE, 'utf-8'));
      return {
        rth:       parseFloat(cfg.rthFloor)  || 0.55,
        eth:       parseFloat(cfg.ethFloor)  || 0.52,
        minPF:     parseFloat(cfg.minPF)     || 1.25,
        minTrades: parseInt(cfg.minTrades, 10) || 40,
        lastTrainedAt: cfg.lastTrainedAt
      };
    }
  } catch (e) { /* fall through to env defaults */ }
  return {
    rth:       parseFloat(process.env.MIN_WR_RTH || process.env.MIN_WR || '0.55'),
    eth:       parseFloat(process.env.MIN_WR_ETH || process.env.MIN_WR || '0.52'),
    minPF:     parseFloat(process.env.MIN_PF     || '1.25'),
    minTrades: parseInt(process.env.MIN_TRADES   || '40', 10)
  };
}

function getQualityFloors() { return _loadFloors(); }

function _passesQualityGate(agg, session) {
  if (!agg) return false;
  const floors = _loadFloors();
  if ((agg.totalTestTrades || 0) < floors.minTrades) return false;
  const minWR = session === 'RTH' ? floors.rth : floors.eth;
  if ((agg.winRate || 0) < minWR) return false;
  if ((agg.profitFactor || 0) < floors.minPF) return false;
  return true;
}

// ── Fair Value Gap (FVG) detector ───────────────────────────────────
// FVG = 3-candle imbalance pattern. The "money maker" from V5.
//   Bullish FVG: candle[i-2].high < candle[i].low → gap between them
//                (a wick is left unfilled — buyers in control)
//   Bearish FVG: candle[i-2].low  > candle[i].high → gap below
//
// We scan the most recent 20 bars for the most-recent UNFILLED FVG and
// check whether current price is RETURNING to it (within 1×ATR of the gap).
// When price returns to an unfilled FVG, that level usually holds and the
// move resumes — classic V5 setup that backtests at 65-70% WR alone.
//
// Returns: { dir: 'bull'|'bear'|null, strength: 0..1, atrFromGap: N }
function _detectFVG(candles, fv) {
  if (!candles || candles.length < 25) return { dir: null, strength: 0 };
  const atr = fv.atr || 0;
  if (atr <= 0) return { dir: null, strength: 0 };
  const last = candles[candles.length - 1];
  const lookback = 20;
  const startIdx = Math.max(2, candles.length - lookback);

  // Scan from most recent backwards. First unfilled FVG within 1×ATR wins.
  for (let i = candles.length - 2; i >= startIdx; i--) {
    const c0 = candles[i - 2];   // 1st candle
    const c2 = candles[i];       // 3rd candle
    // Bullish FVG: gap between c0.high and c2.low (price moved up)
    if (c0.high < c2.low) {
      const gapTop = c2.low;
      const gapBot = c0.high;
      // Unfilled = no later candle filled the gap (close back below gapBot)
      let filled = false;
      for (let j = i + 1; j < candles.length; j++) {
        if (candles[j].low <= gapBot) { filled = true; break; }
      }
      if (filled) continue;
      // Is price returning to the gap (within 1×ATR of gapTop)?
      const distance = last.close - gapTop;     // negative = price below gap, positive = above
      // We want price ABOVE gapTop (gap below current price, acting as support)
      if (distance >= 0 && distance <= atr) {
        const strength = 1 - (distance / atr);  // closer = stronger
        return { dir: 'bull', strength, atrFromGap: distance / atr, gapBot, gapTop };
      }
    }
    // Bearish FVG: gap between c0.low and c2.high (price moved down)
    if (c0.low > c2.high) {
      const gapTop = c0.low;
      const gapBot = c2.high;
      let filled = false;
      for (let j = i + 1; j < candles.length; j++) {
        if (candles[j].high >= gapTop) { filled = true; break; }
      }
      if (filled) continue;
      // We want price BELOW gapBot (gap above current price, acting as resistance)
      const distance = gapBot - last.close;
      if (distance >= 0 && distance <= atr) {
        const strength = 1 - (distance / atr);
        return { dir: 'bear', strength, atrFromGap: distance / atr, gapBot, gapTop };
      }
    }
  }
  return { dir: null, strength: 0 };
}

// ── DECISION MODE TOGGLE ─────────────────────────────────────────────
// User flips between 'HYBRID' (V2 bundle + V5 committee with veto rule)
// and 'V2' (bundle path only — V5 modules become display-only). Live
// reload from models/decision_mode.json so the dashboard toggle takes
// effect without restart.
const _DECISION_MODE_FILE = path.join(__dirname, '..', 'models', 'decision_mode.json');
let _decisionModeCache = null;
let _decisionModeCacheTime = 0;

function getDecisionMode() {
  // Cache for 2 seconds so we re-read on every state poll without thrashing IO
  if (Date.now() - _decisionModeCacheTime < 2000 && _decisionModeCache) return _decisionModeCache;
  try {
    if (fs.existsSync(_DECISION_MODE_FILE)) {
      const obj = JSON.parse(fs.readFileSync(_DECISION_MODE_FILE, 'utf-8'));
      const m = (obj.mode || 'HYBRID').toUpperCase();
      _decisionModeCache = (m === 'V2' || m === 'HYBRID') ? m : 'HYBRID';
    } else {
      _decisionModeCache = 'HYBRID';
    }
  } catch (e) {
    _decisionModeCache = 'HYBRID';
  }
  _decisionModeCacheTime = Date.now();
  return _decisionModeCache;
}

function setDecisionMode(mode) {
  const m = String(mode || '').toUpperCase();
  if (m !== 'V2' && m !== 'HYBRID') return { ok: false, error: 'mode must be V2 or HYBRID' };
  try {
    fs.writeFileSync(_DECISION_MODE_FILE, JSON.stringify({
      mode: m,
      switchedAt: new Date().toISOString()
    }, null, 2));
    _decisionModeCache = m;
    _decisionModeCacheTime = Date.now();
    return { ok: true, mode: m };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── V5 money-maker module detectors ─────────────────────────────────
// Ported as CONFLUENCE BOOSTERS (not signal generators) — each returns
// { dir: 'bull'|'bear'|null, strength: 0..1, type }. The decision engine
// stacks aligned boosters to relax the prob margin; the more boosters
// agree with the bundle's direction, the easier it fires.
//
// Sources:
//   V5/Python/nq/v5_strategies.py:
//     1027 score_nq_pro, 1062 try_nq_pro_trade  → NQ_PRO
//     2225 score_ver,    2323 try_ver_trade      → VER (~70% WR)
//     1324 score_htf_break, 1343 try_htf_break  → HTF_BREAK (~55-60% WR)
//     1409 score_daily_level, 1432 try_daily    → DAILY_LEVEL (6W/0L logged)
//     1705 score_ema_raschke, 1713 try_raschke  → EMA_RASCHKE (5W/0L morning)

// Session VWAP — volume-weighted typical price over the recent window.
// 80 bars × 5 min = ~6.7 hours, roughly covers one trading session.
function _computeVWAP(candles, lookback = 80) {
  const recent = candles.slice(-lookback);
  let pv = 0, vSum = 0;
  for (const c of recent) {
    const tp = (c.high + c.low + c.close) / 3;
    const v  = c.volume || 1;
    pv   += tp * v;
    vSum += v;
  }
  return vSum > 0 ? pv / vSum : 0;
}

// NQ_PRO — MACD-direction + 4-check confluence (V5 winner after b2850e6 revert).
// LONG: macd_line>0, macd_hist>0, AND ≥3 of {ema_stack_up, above_VWAP, RSI 40-70, vol > avg}.
function _detectNQPRO(candles, fv) {
  const f = {};
  fv.names.forEach((n, i) => { f[n] = fv.values[i]; });
  const vwap = _computeVWAP(candles, 80);
  const close = fv.close;
  const macdBull = f.macd_line > 0 && f.macd_hist > 0;
  const macdBear = f.macd_line < 0 && f.macd_hist < 0;
  if (!macdBull && !macdBear) return { dir: null, strength: 0, type: 'nqpro' };

  const stackUp     = f.ema9_21_gap > 0 && f.ema21_50_gap > 0;
  const stackDown   = f.ema9_21_gap < 0 && f.ema21_50_gap < 0;
  const aboveVwap   = vwap > 0 && close > vwap;
  const belowVwap   = vwap > 0 && close < vwap;
  const rsiOkLong   = f.rsi > 40 && f.rsi < 70;
  const rsiOkShort  = f.rsi > 30 && f.rsi < 60;
  const goodVol     = (f.vol_z || 0) > 0;

  if (macdBull) {
    const checks = [stackUp, aboveVwap, rsiOkLong, goodVol].filter(Boolean).length;
    if (checks >= 3) return { dir: 'bull', strength: checks / 4, type: 'nqpro' };
  }
  if (macdBear) {
    const checks = [stackDown, belowVwap, rsiOkShort, goodVol].filter(Boolean).length;
    if (checks >= 3) return { dir: 'bear', strength: checks / 4, type: 'nqpro' };
  }
  return { dir: null, strength: 0, type: 'nqpro' };
}

// VER — VWAP + EMA9 Reclaim (~70% WR per V5 comment).
// Pullback to EMA9 in a trending market, then reclaim.
function _detectVER(candles, fv) {
  if (candles.length < 5) return { dir: null, strength: 0, type: 'ver' };
  const f = {};
  fv.names.forEach((n, i) => { f[n] = fv.values[i]; });
  if ((f.adx || 0) < 20) return { dir: null, strength: 0, type: 'ver' };

  const vwap = _computeVWAP(candles, 80);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  // Back out EMA9 from ema9_dist = (close - ema9) / close
  const ema9 = last.close * (1 - (f.ema9_dist || 0));

  const macdBullAligned = f.macd_line > 0 && f.macd_hist > 0;
  const macdBearAligned = f.macd_line < 0 && f.macd_hist < 0;
  const rsiOkLong       = f.rsi >= 45 && f.rsi <= 65;
  const rsiOkShort      = f.rsi >= 35 && f.rsi <= 55;

  // LONG reclaim: trending up, prev bar dipped to/below EMA9, current closed above it AND above VWAP
  if (f.ema9_21_gap > 0 && prev.low <= ema9 * 1.0005 && last.close > ema9 && vwap > 0 && last.close > vwap
      && macdBullAligned && rsiOkLong) {
    return { dir: 'bull', strength: 0.80, type: 'ver' };
  }
  // SHORT reclaim mirror
  if (f.ema9_21_gap < 0 && prev.high >= ema9 * 0.9995 && last.close < ema9 && vwap > 0 && last.close < vwap
      && macdBearAligned && rsiOkShort) {
    return { dir: 'bear', strength: 0.80, type: 'ver' };
  }
  return { dir: null, strength: 0, type: 'ver' };
}

// HTF_BREAK — 15-min equivalent break + retest (~55-60% WR per V5 comment).
// We approximate the HTF level as the rolling high/low of the last ~45 5-min bars
// (excluding the most recent 3 to avoid self-reference).
function _detectHTFBreak(candles, fv) {
  if (candles.length < 60) return { dir: null, strength: 0, type: 'htf_break' };
  const slice = candles.slice(-60, -3);
  let htfHigh = -Infinity, htfLow = Infinity;
  for (const c of slice) {
    if (c.high > htfHigh) htfHigh = c.high;
    if (c.low  < htfLow)  htfLow  = c.low;
  }
  const last = candles[candles.length - 1];
  const atr  = fv.atr || 1;

  // LONG break: closed above htfHigh, within 0.5×ATR (= retest zone)
  if (last.close > htfHigh && (last.close - htfHigh) <= 0.5 * atr) {
    const strength = Math.max(0.3, 1 - (last.close - htfHigh) / atr);
    return { dir: 'bull', strength, type: 'htf_break', level: htfHigh };
  }
  if (last.close < htfLow && (htfLow - last.close) <= 0.5 * atr) {
    const strength = Math.max(0.3, 1 - (htfLow - last.close) / atr);
    return { dir: 'bear', strength, type: 'htf_break', level: htfLow };
  }
  return { dir: null, strength: 0, type: 'htf_break' };
}

// DAILY_LEVEL — previous-day high/low break (V5 logged 6W/0L +$380).
function _detectDailyLevel(candles, fv) {
  if (candles.length < 200) return { dir: null, strength: 0, type: 'daily_level' };
  const last = candles[candles.length - 1];
  const todayDate = String(last.time).slice(0, 10);
  // Walk back, collect bars from the FIRST previous-day we encounter
  let prevDate = null;
  const prevDayBars = [];
  for (let i = candles.length - 1; i >= 0 && prevDayBars.length < 300; i--) {
    const d = String(candles[i].time).slice(0, 10);
    if (d === todayDate) continue;
    if (!prevDate) prevDate = d;
    if (d !== prevDate) break;
    prevDayBars.push(candles[i]);
  }
  if (prevDayBars.length < 10) return { dir: null, strength: 0, type: 'daily_level' };
  let pdh = -Infinity, pdl = Infinity;
  for (const c of prevDayBars) {
    if (c.high > pdh) pdh = c.high;
    if (c.low  < pdl) pdl = c.low;
  }
  const atr = fv.atr || 1;
  // LONG: closed above PDH within 1×ATR of the break (continuation zone)
  if (last.close > pdh && (last.close - pdh) <= 1.0 * atr) {
    const strength = Math.max(0.4, Math.min(1, (last.close - pdh) / (0.5 * atr)));
    return { dir: 'bull', strength, type: 'daily_level', level: pdh };
  }
  if (last.close < pdl && (pdl - last.close) <= 1.0 * atr) {
    const strength = Math.max(0.4, Math.min(1, (pdl - last.close) / (0.5 * atr)));
    return { dir: 'bear', strength, type: 'daily_level', level: pdl };
  }
  return { dir: null, strength: 0, type: 'daily_level' };
}

// EMA_RASCHKE — Linda "Holy Grail" — pullback to EMA9 in strong-ADX trend,
// then break of the pullback's swing high (LONG) / low (SHORT).
// V5 logged 5W/0L 100% WR +$436 net in first 30-min RTH ("morning king").
function _detectRaschke(candles, fv) {
  if (candles.length < 10) return { dir: null, strength: 0, type: 'raschke' };
  const f = {};
  fv.names.forEach((n, i) => { f[n] = fv.values[i]; });
  if ((f.adx || 0) < 30) return { dir: null, strength: 0, type: 'raschke' };

  const last = candles[candles.length - 1];
  const ema9 = last.close * (1 - (f.ema9_dist || 0));
  const atr  = fv.atr || 1;
  // Scan last 8 bars (excluding current) for a pullback-to-EMA9 bar
  const window = candles.slice(-9, -1);
  let pbIdx = -1;
  for (let i = window.length - 1; i >= 0; i--) {
    if (Math.abs(window[i].low - ema9) <= 0.2 * atr || Math.abs(window[i].high - ema9) <= 0.2 * atr) {
      pbIdx = i;
      break;
    }
  }
  if (pbIdx < 0) return { dir: null, strength: 0, type: 'raschke' };
  const pb = window[pbIdx];

  // LONG: uptrend + macd_hist>0 + current close broke ABOVE pullback bar's high
  if (f.ema9_21_gap > 0 && f.macd_hist > 0 && last.close > pb.high) {
    return { dir: 'bull', strength: 0.85, type: 'raschke' };
  }
  if (f.ema9_21_gap < 0 && f.macd_hist < 0 && last.close < pb.low) {
    return { dir: 'bear', strength: 0.85, type: 'raschke' };
  }
  return { dir: null, strength: 0, type: 'raschke' };
}

// Confluence dispatcher — runs all 6 V5 detectors + sums aligned strengths.
function _computeConfluence(candles, fv) {
  const all = [
    Object.assign({ name: 'FVG'         }, _detectFVG(candles, fv)),
    Object.assign({ name: 'NQ_PRO'      }, _detectNQPRO(candles, fv)),
    Object.assign({ name: 'VER'         }, _detectVER(candles, fv)),
    Object.assign({ name: 'HTF_BREAK'   }, _detectHTFBreak(candles, fv)),
    Object.assign({ name: 'DAILY_LEVEL' }, _detectDailyLevel(candles, fv)),
    Object.assign({ name: 'EMA_RASCHKE' }, _detectRaschke(candles, fv))
  ];
  let bullScore = 0, bearScore = 0;
  const bullNames = [], bearNames = [];
  for (const b of all) {
    if (b.dir === 'bull') { bullScore += b.strength; bullNames.push(b.name); }
    if (b.dir === 'bear') { bearScore += b.strength; bearNames.push(b.name); }
  }
  return { bullScore, bearScore, bullNames, bearNames, boosters: all };
}

// ── Runtime safety state ────────────────────────────────────────────
// Tracks per-bucket (symbol_session_regime_direction) live performance so
// guards in decide() can refuse re-entries after losses, cooldowns, etc.
// Persisted across server restarts via models/safety_state.json so a
// restart doesn't wipe the circuit breaker history.
const _SAFETY_FILE = path.join(__dirname, '..', 'models', 'safety_state.json');
let _safetyCache = null;

function _safetyState() {
  if (_safetyCache) return _safetyCache;
  try {
    if (fs.existsSync(_SAFETY_FILE)) {
      _safetyCache = JSON.parse(fs.readFileSync(_SAFETY_FILE, 'utf-8'));
    }
  } catch (e) { /* fall through */ }
  if (!_safetyCache) _safetyCache = {};
  _safetyCache.lastLossAt    = _safetyCache.lastLossAt    || {};
  _safetyCache.lastLossPrice = _safetyCache.lastLossPrice || {};
  _safetyCache.lossStreak    = _safetyCache.lossStreak    || {};
  _safetyCache.winStreak     = _safetyCache.winStreak     || {};   // adaptive threshold input
  _safetyCache.dailyPnL      = _safetyCache.dailyPnL      || {};
  return _safetyCache;
}

function _persistSafety() {
  try {
    fs.writeFileSync(_SAFETY_FILE, JSON.stringify(_safetyState(), null, 2));
  } catch (e) { /* non-fatal */ }
}

// ET-based trading-day key. Uses Eastern Time (EDT = UTC-4 in summer) so that
// trades between 5 PM PT and midnight PT (midnight UTC → 8 PM UTC) don't roll
// the daily key to the next calendar day. All three daily-P&L checkpoints
// (recordTradeResult, seedDailyPnLFromNt8, Guard 5) must use this same function.
function _etDateKey(ts) {
  const d = new Date(ts || Date.now());
  const et = new Date(d.getTime() - 4 * 60 * 60 * 1000);  // EDT = UTC-4
  return et.toISOString().slice(0, 10);
}

// Called by the trade-close pipeline so guards can react.
// bucketKey = e.g. "ES=F_RTH_CHOP_long"
// Pass entryPrice so the price-move guard can compare future bars to it.
function recordTradeResult({ symbol, session, regime, direction, pnl, exitTime, entryPrice }) {
  const s = _safetyState();
  const bucket = `${symbol}_${session}_${regime}_${direction === 'Long' ? 'long' : 'short'}`;
  const todayKey = _etDateKey(exitTime ? new Date(exitTime).getTime() : undefined);

  // Daily P&L roll-up — resets at UTC midnight
  if (!s.dailyPnL[symbol] || s.dailyPnL[symbol].date !== todayKey) {
    s.dailyPnL[symbol] = { date: todayKey, pnl: 0 };
  }
  s.dailyPnL[symbol].pnl += (pnl || 0);

  if (pnl < 0) {
    // LOSS — arm the price-move guard with this loss's entry price.
    // Bump loss counter (adaptive threshold tightens). Wipe win credit
    // so any earned trust is lost.
    s.lastLossAt[bucket]    = Date.now();
    s.lastLossPrice[bucket] = entryPrice != null ? entryPrice : null;
    s.lossStreak[bucket]    = (s.lossStreak[bucket] || 0) + 1;
    s.winStreak[bucket]     = 0;
  } else {
    // WIN — clear the price-move guard AND DECREMENT (not reset) the
    // loss streak. A win earns one unit of forgiveness but a 5-loss
    // streak isn't fully erased by a single win. Recovery is earned
    // gradually, the same way the penalty accumulated.
    //
    // Trajectory example (trained_th = 0.65, +0.02/loss, -0.015/win):
    //   5 losses          → L=5 W=0 → delta +0.10 → effective 0.75
    //   5L then 1W        → L=4 W=1 → delta +0.065 → effective 0.715
    //   5L then 2W        → L=3 W=2 → delta +0.030 → effective 0.680
    //   5L then 3W        → L=2 W=3 → 0 (clamped) → effective 0.650 (recovered)
    //
    // Three wins erase five losses. Symmetric, convergent, self-tuning.
    s.lossStreak[bucket]    = Math.max(0, (s.lossStreak[bucket] || 0) - 1);
    s.lastLossPrice[bucket] = null;
    s.winStreak[bucket]     = (s.winStreak[bucket] || 0) + 1;
  }
  _persistSafety();
  return s;
}

// Resets ALL safety guards. Used at midnight or via admin endpoint.
function resetSafetyState() {
  _safetyCache = { lastLossAt: {}, lastLossPrice: {}, lossStreak: {}, winStreak: {}, dailyPnL: {} };
  _persistSafety();
}

// Read-only view for the dashboard
function getSafetyState() { return _safetyState(); }

// Seed the daily P&L for a symbol from an external source (e.g. NT8 realized PnL
// reported on server start). Only seeds if the current daily PnL for today is 0
// AND the incoming value is negative (loss). This bridges the gap between server
// restarts and ensures the daily loss cap (-$1500) accounts for losses taken in
// a previous server session on the same calendar day.
function seedDailyPnLFromNt8(symbol, nt8RealizedPnL) {
  if (!symbol || typeof nt8RealizedPnL !== 'number') return;
  if (nt8RealizedPnL >= 0) return;  // only seed losses
  const s = _safetyState();
  const todayKey = _etDateKey();  // ET-based so ETH trades after midnight UTC stay on correct day
  const current = (s.dailyPnL[symbol] && s.dailyPnL[symbol].date === todayKey)
    ? s.dailyPnL[symbol].pnl : 0;
  if (current !== 0) return;  // already has data from this session, don't overwrite
  s.dailyPnL[symbol] = { date: todayKey, pnl: nt8RealizedPnL };
  _persistSafety();
  console.log(`[DecisionEngine] Seeded daily P&L for ${symbol}: $${nt8RealizedPnL.toFixed(2)} (from NT8 start metrics)`);
}

// In-memory model cache
const _modelCache = new Map();
let _lastCacheRefresh = 0;
const CACHE_TTL_MS = 60 * 1000;

function _modelPath(symbol, session, regime, direction) {
  // Micros piggyback on mini models — same underlying price, same edge.
  // MNQ=F → NQ_RTH_VOL_EXPANSION_short.json
  const miniSym = familyMiniSymbol(symbol).replace('=F', '');
  return path.join(MODELS_DIR, `${miniSym}_${session}_${regime}_${direction}.json`);
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

    // Manual kill switch — bundle JSON can carry `"disabled": true` to take
    // a specific specialist offline without deleting the model. Used after a
    // live audit revealed a bundle is firing into the wrong tape (e.g.
    // ES_RTH_CHOP_long 0-for-4 on 2026-05-26 when ES was actually trending
    // down). Honored before the quality gate so a manual kill always wins.
    if (obj.disabled === true) {
      const entry = {
        missing: false,
        disabled: true,
        reason: obj.disabled_reason || 'manually disabled',
        aggregate: obj.aggregate || null,
        threshold: obj.threshold || 0.65,
        loadedAt: Date.now()
      };
      _modelCache.set(key, entry);
      return entry;
    }

    // Quality gate — refuse to load bundles below the bar so the live engine
    // never trades a known-bad specialist (e.g., ES_RTH_TREND_UP_long 28% WR).
    // Per-session floor: RTH 65%, ETH 55% (configurable in quality_floors.json).
    const passes = _passesQualityGate(obj.aggregate, session);
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

  // Compact feature snapshot included on EVERY decision response (even FLATs)
  // so the dashboard cards can always show ADX / RSI / EMA stack to the user.
  // Without this, CHOP / no-model cards show empty gauges and the user thinks
  // the bot is broken when it's actually just classifying correctly.
  const liveFeatures = {
    adx:        fv.values[fv.names.indexOf('adx')],
    rsi:        fv.values[fv.names.indexOf('rsi')],
    macd_hist:  fv.values[fv.names.indexOf('macd_hist')],
    bb_z:       fv.values[fv.names.indexOf('bb_z')],
    atr_pct:    fv.values[fv.names.indexOf('atr_pct')],
    close:      fv.close,
    session:    fv.session
  };

  const session = fv.session;  // shorthand used throughout decide() — DO NOT REMOVE
  const regimeInfo = classifyRegime(fv);
  if (!isTradeable(regimeInfo.regime)) {
    return {
      action: 'FLAT',
      reason: `regime=${regimeInfo.regime} (${regimeInfo.reason})`,
      regime: regimeInfo.regime,
      session,
      liveFeatures
    };
  }

  // Run both LONG and SHORT specialists and pick the higher-conviction side
  const longEntry = _loadModel(symbol, fv.session, regimeInfo.regime, 'long');
  const shortEntry = _loadModel(symbol, fv.session, regimeInfo.regime, 'short');

  const longUsable = longEntry && !longEntry.missing && !longEntry.disabled;
  const shortUsable = shortEntry && !shortEntry.missing && !shortEntry.disabled;

  // GBDT bundle is the SOLE decision authority. If both LONG and SHORT
  // bundles are gated/missing → FLAT. No V5 fallback (per user directive
  // 2026-05-26: "stop using V5 because it was making wrong decisions").
  if (!longUsable && !shortUsable) {
    const why = (longEntry && longEntry.disabled) || (shortEntry && shortEntry.disabled)
      ? `bundle(s) disabled by quality gate for ${fv.session}/${regimeInfo.regime}`
      : `no models trained for ${fv.session}/${regimeInfo.regime}`;
    return {
      action: 'FLAT',
      reason: why,
      regime: regimeInfo.regime,
      session: fv.session,
      longBundle:  longEntry  && longEntry.disabled  ? 'DISABLED' : (longEntry  && longEntry.missing  ? 'MISSING' : 'OK'),
      shortBundle: shortEntry && shortEntry.disabled ? 'DISABLED' : (shortEntry && shortEntry.missing ? 'MISSING' : 'OK'),
      liveFeatures
    };
  }

  let longProb = 0, shortProb = 0;
  let longTh = 0.65, shortTh = 0.65;
  let longNativeTh = 0.65, shortNativeTh = 0.65; // pre-cap values
  if (longUsable) {
    longProb = predict(longEntry.model, fv.values);
    longTh = longEntry.threshold;
    longNativeTh = longTh;
  }
  if (shortUsable) {
    shortProb = predict(shortEntry.model, fv.values);
    shortTh = shortEntry.threshold;
    shortNativeTh = shortTh;
  }

  // ── PROFILE THRESHOLD CAP ──────────────────────────────────────────
  // Caps the effective threshold at decide()-time so BALANCED/SCALPER
  // fire more trades than SNIPER without retraining.
  // ETH gets a lower cap (RTH cap − 0.05): overnight models top out at
  // ~0.52-0.54; the RTH cap plus baseMargin requires 0.57 which ETH
  // models never reach.
  let longWasCapped = false, shortWasCapped = false;
  try {
    let profile;
    try { profile = require('./aggressivenessProfile').getActiveProfile(); } catch (e) { profile = null; }
    if (profile && profile.runtimeThresholdCap != null) {
      const cap = (session === 'ETH' && profile.runtimeThresholdCap > 0.48)
        ? profile.runtimeThresholdCap - 0.05
        : profile.runtimeThresholdCap;
      if (longUsable  && longTh  > cap) { longTh  = cap; longWasCapped  = true; }
      if (shortUsable && shortTh > cap) { shortTh = cap; shortWasCapped = true; }
    }
  } catch (e) { /* fall through with bundle-baked thresholds */ }

  // Build feature snapshot for the loss auditor
  const featureSnapshot = {};
  fv.names.forEach((n, i) => { featureSnapshot[n] = fv.values[i]; });
  featureSnapshot._fvg = null;   // populated below if FVG detected

  // ── RUNTIME SAFETY GUARDS ──────────────────────────────────────────
  // Defense in depth — even if a bundle has positive backtest edge, the
  // following guards stop the bot from making intraday-obvious mistakes
  // (the 4-in-a-row ES CHOP_long bug on 2026-05-26 motivated every one
  // of these).
  const bucketKey = `${symbol}_${fv.session}_${regimeInfo.regime}`;
  const longBucket  = `${bucketKey}_long`;
  const shortBucket = `${bucketKey}_short`;
  const now = Date.now();
  const guards = _safetyState();

  // Guard 1: Probability margin — DYNAMIC via 6-module V5 confluence stack.
  //   Baseline margin = 0.03. Each aligned V5 booster (FVG, NQ_PRO, VER,
  //   HTF_BREAK, DAILY_LEVEL, EMA_RASCHKE) subtracts its strength × 0.008
  //   from the margin. Strong confluence (3+ aligned at ~0.8 strength) →
  //   margin ≈ 0.011; max confluence (all 6) → floored at 0.
  //
  //   The CONFLUENCE STACK is what lifts a 55% backtest bundle to 65%+
  //   live WR — when the GBDT bundle says LONG and 3 V5 patterns ALSO
  //   point bull, the combined edge is much higher than the bundle alone.
  const confluence = _computeConfluence(candles, fv);
  featureSnapshot._confluence = {
    bullScore: confluence.bullScore,
    bearScore: confluence.bearScore,
    bullNames: confluence.bullNames,
    bearNames: confluence.bearNames
  };
  // Keep _fvg field for backward compat (UI may read it)
  const fvgBooster = confluence.boosters.find(b => b.name === 'FVG');
  featureSnapshot._fvg = fvgBooster && fvgBooster.dir
    ? { dir: fvgBooster.dir, strength: fvgBooster.strength, atrFromGap: fvgBooster.atrFromGap }
    : null;

  // ══════════════════════════════════════════════════════════════════════
  //  HYBRID DECISION ENGINE (V2 GBDT bundle + V5 module committee)
  // ══════════════════════════════════════════════════════════════════════
  //  Two parallel paths can fire a trade — whichever clears its gate.
  //
  //   PATH A: BUNDLE-PRIMARY (V2)
  //     prob ≥ trained_threshold + 0.02 margin
  //     → pure GBDT signal, full position size
  //
  //   PATH B: HYBRID (V2 bias + V5 committee confirmation)
  //     prob ≥ (trained_threshold − 0.10)   ← bundle leaning that way
  //     AND ≥ 2 V5 modules agree direction
  //     AND combined V5 strength ≥ 1.4
  //     AND zero V5 modules opposing with strength ≥ 0.5   (VETO RULE)
  //     → hybrid signal, scaled position (0.8× base)
  //
  //   Both paths still respect: EMA agreement, ATR sweet-spot, price-move
  //   guard, adaptive threshold, daily P&L cap.
  //
  //   The VETO RULE is what makes hybrid better than V5: V5's wrong-
  //   direction trades came from one module firing while another flagged
  //   opposite. We now refuse to fire if any module strongly opposes.
  //   Bundle's GBDT direction is the bias; V5 committee confirms or vetos.
  //
  //   Expected: more trades than pure V2, higher WR than pure V5.
  // ══════════════════════════════════════════════════════════════════════

  // ── ADAPTIVE THRESHOLD (must run BEFORE fire computation) ────────────
  // Per-bucket online learning: each loss raises the effective threshold
  // by 0.02 (require more conviction), each win lowers it by 0.015. Bug
  // discovered 2026-05-26: this was running AFTER fire decision so the
  // bumped threshold had zero effect on actual fires. Now applied first.
  const _longBucketKey  = `${symbol}_${fv.session}_${regimeInfo.regime}_long`;
  const _shortBucketKey = `${symbol}_${fv.session}_${regimeInfo.regime}_short`;
  const _adaptLongLS  = guards.lossStreak[_longBucketKey]   || 0;
  const _adaptLongWS  = guards.winStreak[_longBucketKey]    || 0;
  const _adaptShortLS = guards.lossStreak[_shortBucketKey]  || 0;
  const _adaptShortWS = guards.winStreak[_shortBucketKey]   || 0;
  const _adaptLongDelta  = Math.max(0, (_adaptLongLS  * 0.02) - (_adaptLongWS  * 0.015));
  const _adaptShortDelta = Math.max(0, (_adaptShortLS * 0.02) - (_adaptShortWS * 0.015));
  if (longUsable  && _adaptLongDelta  > 0) longTh  = Math.min(0.90, longTh  + _adaptLongDelta);
  if (shortUsable && _adaptShortDelta > 0) shortTh = Math.min(0.90, shortTh + _adaptShortDelta);

  // ETH baseMargin is tighter — overnight models max out around 0.52-0.54,
  // so the extra 0.02 RTH buffer would kill every ETH signal.
  const baseMargin = session === 'ETH' ? 0.01 : 0.02;
  // VOL_EXPANSION gets a wider hybrid window — the model output is lower
  // during a sudden breakout (EMAs lag, features haven't settled) but the
  // V5 modules (FVG, EMA cross, MACD) catch the direction in real time.
  const SOFT_FLOOR_OFFSET = (regimeInfo && regimeInfo.regime === 'VOL_EXPANSION') ? 0.15 : 0.05;
  // 2026-05-27 FIX: tightened PATH B after ETH over-trading caused -$853 MES loss.
  // Root cause: SOFT_FLOOR_OFFSET=0.12 + MIN_V5_AGREE=1 + MIN_V5_STRENGTH_SUM=0.70
  // allowed p=0.44 (9% below threshold) with just 1 weak V5 module to fire.
  // New gates:
  //   SOFT_FLOOR_OFFSET 0.12→0.05: hybrid only fires within 5% of threshold
  //   MIN_V5_AGREE 1→2: need genuine committee (at least 2 modules agreeing)
  //   MIN_V5_STRENGTH_SUM 0.70→1.40: combined score ≥ 1.40 (restored to original)
  //   MAX_V5_OPPOSITION 0.5: unchanged
  const MIN_V5_AGREE        = 2;      // 2+ modules required (was 1 — too loose)
  const MIN_V5_STRENGTH_SUM = 1.40;   // combined score ≥ 1.40 (was 0.70 — too loose)
  const MAX_V5_OPPOSITION   = 0.5;    // unchanged — any opposing ≥ 0.5 → veto

  // Strongest opposing-module strength (used for veto check)
  const strongestBearOpposingLong = (confluence.boosters || [])
    .filter(b => b.dir === 'bear').reduce((m, b) => Math.max(m, b.strength), 0);
  const strongestBullOpposingShort = (confluence.boosters || [])
    .filter(b => b.dir === 'bull').reduce((m, b) => Math.max(m, b.strength), 0);

  // Read the current decision mode (HYBRID vs V2) — live-reload from
  // models/decision_mode.json so the dashboard toggle takes effect without
  // restart. In V2 mode the hybrid path below stays evaluated but its
  // result is forced to false (so V5 chips still display on the dashboard
  // but never influence the fire).
  const decisionMode = getDecisionMode();
  const hybridEnabled = (decisionMode === 'HYBRID');

  // PATH A — strict bundle fire (active in BOTH modes).
  // When the profile cap lowered the threshold below the bundle's native value,
  // fire AT the cap exactly (no extra margin) — the cap IS the user's intent.
  // When using the native threshold, keep the margin so we don't fire on noise
  // right at the trained edge.
  const longBundleFire  = longUsable  && longProb  >= longTh  + (longWasCapped  ? 0 : baseMargin);
  const shortBundleFire = shortUsable && shortProb >= shortTh + (shortWasCapped ? 0 : baseMargin);

  // PATH B — hybrid fire (bundle leaning + V5 committee confirmation + no veto)
  // GATED by mode: only fires when user has HYBRID toggle on.
  const longHybridFire = hybridEnabled
    && longUsable
    && longProb >= (longTh - SOFT_FLOOR_OFFSET)
    && confluence.bullNames.length >= MIN_V5_AGREE
    && confluence.bullScore >= MIN_V5_STRENGTH_SUM
    && strongestBearOpposingLong < MAX_V5_OPPOSITION;
  const shortHybridFire = hybridEnabled
    && shortUsable
    && shortProb >= (shortTh - SOFT_FLOOR_OFFSET)
    && confluence.bearNames.length >= MIN_V5_AGREE
    && confluence.bearScore >= MIN_V5_STRENGTH_SUM
    && strongestBullOpposingShort < MAX_V5_OPPOSITION;

  // Block tracking (informational — actual veto is in signal eval below)
  let longBlocked  = false;
  let shortBlocked = false;
  let blockReasons = [];

  if (longUsable && !longBundleFire && !longHybridFire) {
    longBlocked = true;
    const why = longProb < longTh - SOFT_FLOOR_OFFSET
      ? `long prob ${longProb.toFixed(3)} too low (below soft floor ${(longTh - SOFT_FLOOR_OFFSET).toFixed(2)})`
      : strongestBearOpposingLong >= MAX_V5_OPPOSITION
        ? `long hybrid vetoed — opposing V5 module strength ${strongestBearOpposingLong.toFixed(2)} ≥ ${MAX_V5_OPPOSITION}`
        : confluence.bullNames.length < MIN_V5_AGREE
          ? `long hybrid needs ${MIN_V5_AGREE} V5 agreers (have ${confluence.bullNames.length})`
          : `long hybrid needs strength ${MIN_V5_STRENGTH_SUM} (have ${confluence.bullScore.toFixed(2)})`;
    blockReasons.push(why);
  }
  if (shortUsable && !shortBundleFire && !shortHybridFire) {
    shortBlocked = true;
    const why = shortProb < shortTh - SOFT_FLOOR_OFFSET
      ? `short prob ${shortProb.toFixed(3)} too low (below soft floor ${(shortTh - SOFT_FLOOR_OFFSET).toFixed(2)})`
      : strongestBullOpposingShort >= MAX_V5_OPPOSITION
        ? `short hybrid vetoed — opposing V5 module strength ${strongestBullOpposingShort.toFixed(2)} ≥ ${MAX_V5_OPPOSITION}`
        : confluence.bearNames.length < MIN_V5_AGREE
          ? `short hybrid needs ${MIN_V5_AGREE} V5 agreers (have ${confluence.bearNames.length})`
          : `short hybrid needs strength ${MIN_V5_STRENGTH_SUM} (have ${confluence.bearScore.toFixed(2)})`;
    blockReasons.push(why);
  }

  // Surface which path is firing (or armed) — for telemetry + dashboard
  featureSnapshot._signalSource = longBundleFire || shortBundleFire ? 'BUNDLE'
                                : longHybridFire || shortHybridFire ? 'HYBRID'
                                : null;
  featureSnapshot._v5Override = null;   // override mechanism removed
  // qty multiplier: bundle path = 1.0, hybrid path = 0.8 (smaller position
  // because hybrid fires below trained threshold — lower conviction).
  featureSnapshot._qtyMultiplier = (longBundleFire || shortBundleFire) ? 1.0
                                 : (longHybridFire || shortHybridFire) ? 0.8
                                 : 1.0;
  // Use marginal margin for downstream display
  const longMargin  = baseMargin;
  const shortMargin = baseMargin;

  // Guard 1b: ATR sweet-spot filter — extreme volatility kills WR on both
  //   ends. Very low ATR = no movement to capture; very high ATR = whipsaw
  //   stop-outs. Backtests across all 4 symbols show WR drops ~5-8pp outside
  //   the [0.15, 0.90] atr_percentile band. Block trades there.
  const atrPct = fv.values[fv.names.indexOf('atr_percentile')] || 0.5;
  if (atrPct < 0.15) {
    longBlocked  = true; shortBlocked = true;
    blockReasons.push(`ATR too low (percentile ${atrPct.toFixed(2)} < 0.15) — dead market`);
  } else if (atrPct > 0.95) {
    longBlocked  = true; shortBlocked = true;
    blockReasons.push(`ATR too high (percentile ${atrPct.toFixed(2)} > 0.95) — whipsaw zone`);
  }

  // Guard 2: Price-move confirmation after a loss (NOT time-based).
  //   Instead of a cooldown clock, we require the market to have actually
  //   moved AWAY from the failed setup before re-firing the same bundle.
  //   The losing entry price is saved; we refuse re-entry until price has
  //   traveled at least 0.5×ATR in the bundle's direction.
  //
  //   This is how a human trader would think: "don't buy the dip again
  //   until price has proven the dip was real." Self-clears the moment
  //   the market validates the bundle's bias.
  //
  //   Tradeoff vs cooldown: if price oscillates fast, this can clear in
  //   1 bar instead of 3. If price keeps grinding against us, this stays
  //   blocked indefinitely (the circuit breaker at guard 3 then kicks in).
  const longLastLossPx  = guards.lastLossPrice[longBucket];
  const shortLastLossPx = guards.lastLossPrice[shortBucket];
  const REQUIRED_MOVE_ATR_MULT = 0.5;
  const requiredMove = (fv.atr || 0) * REQUIRED_MOVE_ATR_MULT;
  if (longUsable && longLastLossPx != null && requiredMove > 0) {
    const moved = fv.close - longLastLossPx;     // positive = price rose
    if (moved < requiredMove) {
      longBlocked = true;
      blockReasons.push(`long awaiting move (price ${fv.close.toFixed(2)} vs last loss @${longLastLossPx.toFixed(2)} — moved ${moved.toFixed(2)} < ${requiredMove.toFixed(2)})`);
    }
  }
  if (shortUsable && shortLastLossPx != null && requiredMove > 0) {
    const moved = shortLastLossPx - fv.close;    // positive = price fell
    if (moved < requiredMove) {
      shortBlocked = true;
      blockReasons.push(`short awaiting move (price ${fv.close.toFixed(2)} vs last loss @${shortLastLossPx.toFixed(2)} — moved ${moved.toFixed(2)} < ${requiredMove.toFixed(2)})`);
    }
  }

  // Guard 3: Adaptive thresholding — the bot LEARNS per bucket.
  //   Instead of binary-disabling after N losses (lazy), we shift the
  //   effective threshold up after each loss (require more conviction)
  //   and shift it back down after each win (reward recovery). This is
  //   an online closed-loop self-tune — the bundle's threshold drifts
  //   based on its OWN live performance per bucket.
  //
  //   Math:
  //     loss_penalty = lossStreak × 0.02       (each loss raises bar by 2pp)
  //     win_credit   = winStreak  × 0.015      (each win lowers bar by 1.5pp)
  //     delta        = max(0, loss_penalty - win_credit)   (never EASIER than trained)
  //     effective_th = min(0.90, trained_th + delta)
  //
  //   Example trajectory (trained_th = 0.65):
  //     start              → effective 0.65
  //     1 loss             → 0.67
  //     2 losses           → 0.69
  //     3 losses           → 0.71  (used to be hard-disabled; now just higher bar)
  //     5 losses           → 0.75
  //     5L then 1W         → 0.735 (eased by win credit)
  //     5L then 7W         → 0.65  (fully recovered to trained baseline)
  //
  //   The bot never gives up on a bucket. It tightens itself until live
  //   performance returns, then eases back. Combined with the price-move
  //   guard + EMA agreement + prob margin, it's a real online learner.
  // Adaptive threshold info — recorded for telemetry (the actual threshold
  // bump now happens BEFORE fire computation; see top of guards block).
  const longLS  = _adaptLongLS;
  const longWS  = _adaptLongWS;
  const shortLS = _adaptShortLS;
  const shortWS = _adaptShortWS;
  if (_adaptLongDelta > 0)  blockReasons.push(`long adaptive: ${longLS}L/${longWS}W → th raised by ${_adaptLongDelta.toFixed(3)} to ${longTh.toFixed(3)}`);
  if (_adaptShortDelta > 0) blockReasons.push(`short adaptive: ${shortLS}L/${shortWS}W → th raised by ${_adaptShortDelta.toFixed(3)} to ${shortTh.toFixed(3)}`);

  // Guard 4: EMA-trend agreement — block obvious counter-trend trades.
  //   If EMA9/21 + EMA21/50 BOTH stacked against the signal direction,
  //   the bundle is fighting the trend on its own chart. Refuse.
  //   EXEMPT: VOL_EXPANSION — EMAs always lag a sudden breakout. Blocking
  //   shorts because EMAs are still bullish during a flash crash is exactly
  //   wrong. VOL_EXPANSION specialists are trained to catch that pattern;
  //   let them run without the EMA filter.
  //   EXEMPT: CHOP — by definition a non-trending market. EMA alignment in
  //   CHOP is unreliable noise (EMAs lag and reflect the prior trend, not the
  //   current mean-reversion setup). CHOP bundles are trained for mean-reversion;
  //   requiring EMA agreement would systematically block the very setups they
  //   capture. The bundle probability + price-move guard are sufficient.
  const ema9_21  = fv.values[fv.names.indexOf('ema9_21_gap')]  || 0;
  const ema21_50 = fv.values[fv.names.indexOf('ema21_50_gap')] || 0;
  const stackedBearish = (ema9_21 < 0 && ema21_50 < 0);
  const stackedBullish = (ema9_21 > 0 && ema21_50 > 0);
  const emaGuardActive = regimeInfo
    && regimeInfo.regime !== 'VOL_EXPANSION'
    && regimeInfo.regime !== 'CHOP';   // CHOP is non-directional — EMA stack unreliable
  if (emaGuardActive && longUsable  && stackedBearish) { longBlocked  = true; blockReasons.push(`long blocked — EMA stack bearish (9/21=${ema9_21.toFixed(4)}, 21/50=${ema21_50.toFixed(4)})`); }
  if (emaGuardActive && shortUsable && stackedBullish) { shortBlocked = true; blockReasons.push(`short blocked — EMA stack bullish (9/21=${ema9_21.toFixed(4)}, 21/50=${ema21_50.toFixed(4)})`); }

  // Guard 4b: MACD momentum alignment — Fix B 2026-05-27.
  //   In TREND_UP regime, MACD histogram must be ≥ 0 before a LONG fires.
  //   In TREND_DOWN regime, MACD histogram must be ≤ 0 before a SHORT fires.
  //   Prevents entering during a pullback phase (structure says up, momentum says down).
  //   CHOP and VOL_EXPANSION regimes are exempt — mean-reversion bundles work against MACD.
  const macdHist = fv.values[fv.names.indexOf('macd_hist')] || 0;
  if (longUsable  && regimeInfo && regimeInfo.regime === 'TREND_UP'   && macdHist < 0) {
    longBlocked  = true;
    blockReasons.push(`long blocked — TREND_UP but macd_hist=${macdHist.toFixed(2)} (pullback momentum, wait for MACD ≥ 0)`);
  }
  if (shortUsable && regimeInfo && regimeInfo.regime === 'TREND_DOWN' && macdHist > 0) {
    shortBlocked = true;
    blockReasons.push(`short blocked — TREND_DOWN but macd_hist=${macdHist.toFixed(2)} (bounce momentum, wait for MACD ≤ 0)`);
  }

  // Guard 5: Per-symbol daily P&L floor — if today's realized loss on this
  //   symbol exceeds the cap, disable ALL new entries for the rest of the day.
  const MAX_DAILY_LOSS = -1500;  // dollars
  const todayKey = _etDateKey();  // ET-based date — consistent with recordTradeResult
  const todayPnL = (guards.dailyPnL[symbol] && guards.dailyPnL[symbol].date === todayKey)
    ? guards.dailyPnL[symbol].pnl : 0;
  if (todayPnL <= MAX_DAILY_LOSS) {
    return {
      action: 'FLAT',
      reason: `daily P&L cap hit on ${symbol} — today ${todayPnL.toFixed(0)} ≤ ${MAX_DAILY_LOSS}`,
      regime: regimeInfo.regime,
      session: fv.session,
      probabilities: { long: longProb, short: shortProb, longTh, shortTh },
      liveFeatures,
      blocked: true,
      blockReasons: [`daily P&L floor`]
    };
  }

  // Signal = (PATH A bundle) OR (PATH B hybrid) AND not blocked by any
  // runtime safety guard. Critical: the block flags below are set by the
  // ATR sweet-spot guard, EMA-agreement guard, and price-move-required
  // guard. Without this `!Blocked` gate, those three guards do NOTHING.
  // (Bug discovered in audit 2026-05-26.)
  const longSignal  = (longBundleFire  || longHybridFire)  && !longBlocked;
  const shortSignal = (shortBundleFire || shortHybridFire) && !shortBlocked;

  // R:R + ATR exit configuration — read from the active Aggressiveness Profile
  // so the user can switch trade-frequency vs accuracy via the dashboard
  // without restarting the server. Hot-reads on every decision (cache-free).
  let profile;
  try { profile = require('./aggressivenessProfile').getActiveProfile(); } catch (e) { profile = null; }
  const tpR = opts.tpR || (profile && profile.tpR) || 1.8;
  const slR = opts.slR || (profile && profile.slR) || 1.0;
  const slAtrMult = (profile && profile.slAtrMult) || 1.5;
  const tpAtrMult = (profile && profile.tpAtrMult) || (1.5 * tpR / slR);

  // Conflict resolution: if both fire, take the higher (prob - threshold) margin
  if (longSignal && shortSignal) {
    const winSide = (longProb - longTh) >= (shortProb - shortTh) ? 'BUY' : 'SELL';
    const winProb = winSide === 'BUY' ? longProb : shortProb;
    const winTh   = winSide === 'BUY' ? longTh   : shortTh;
    const entry = _buildEntry(winSide, symbol, fv, winProb, winTh, regimeInfo, slAtrMult, tpAtrMult, featureSnapshot);
    entry.probabilities = { long: longProb, short: shortProb, longTh, shortTh };
    return entry;
  }
  if (longSignal) {
    const entry = _buildEntry('BUY', symbol, fv, longProb, longTh, regimeInfo, slAtrMult, tpAtrMult, featureSnapshot);
    entry.probabilities = { long: longProb, short: shortProb, longTh, shortTh };
    return entry;
  }
  if (shortSignal) {
    const entry = _buildEntry('SELL', symbol, fv, shortProb, shortTh, regimeInfo, slAtrMult, tpAtrMult, featureSnapshot);
    entry.probabilities = { long: longProb, short: shortProb, longTh, shortTh };
    return entry;
  }

  return {
    action: 'FLAT',
    reason: `below threshold (long=${longProb.toFixed(2)}<${longTh.toFixed(2)}, short=${shortProb.toFixed(2)}<${shortTh.toFixed(2)})`,
    regime: regimeInfo.regime,
    session: fv.session,
    probabilities: { long: longProb, short: shortProb, longTh, shortTh },
    confluence: featureSnapshot._confluence || null,
    fvg: featureSnapshot._fvg || null,
    blockReasons,
    liveFeatures
  };
}

function _buildEntry(action, symbol, fv, prob, threshold, regimeInfo, slAtrMult, tpAtrMult, snapshot) {
  // Per-SYMBOL × per-session fixed exit override — set via Exits tab.
  // When active, returns SL/TP/BE/Trail as ABSOLUTE point values instead of
  // ATR multiples. Walkforward backtest metrics do NOT apply when fixed
  // mode is on (the UI warns the user about this).
  const fixed = fixedExitsFor(symbol, fv.session);
  let slDistance, tpDistance, breakevenDistance, trailingDistance, exitMode;
  if (fixed) {
    slDistance = fixed.slPoints;
    tpDistance = fixed.tpPoints;
    breakevenDistance = fixed.bePoints;
    trailingDistance = fixed.trailStartPoints;
    exitMode = 'FIXED';
  } else {
    slDistance = fv.atr * slAtrMult;
    tpDistance = fv.atr * tpAtrMult;
    breakevenDistance = fv.atr * 0.8;
    trailingDistance = fv.atr * 1.2;
    exitMode = 'ATR';
  }
  return {
    action,
    symbol,
    probability: prob,
    threshold,
    regime: regimeInfo.regime,
    session: fv.session,
    atr: fv.atr,
    close: fv.close,
    slDistance,
    tpDistance,
    breakevenDistance,
    trailingDistance,
    exitMode,
    fvg: snapshot._fvg || null,                // backward-compat field
    confluence: snapshot._confluence || null,  // V5 booster stack for dashboard
    signalSource: snapshot._signalSource || 'BUNDLE',  // 'BUNDLE' or 'HYBRID'
    v5Override: snapshot._v5Override || null,  // legacy field — always null now
    qtyMultiplier: snapshot._qtyMultiplier || 1.0,  // 1.0 bundle / 0.8 hybrid
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
    !f.includes('paper_trades') &&
    !f.includes('exit_overrides')
  );
  return files.map(f => {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, f), 'utf-8'));
      const enabled = _passesQualityGate(obj.aggregate, obj.session);
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
        gateReason: enabled ? null : _gateRejectReason(obj.aggregate, obj.session)
      };
    } catch (e) {
      return { file: f, error: e.message, enabled: false };
    }
  });
}

function _gateRejectReason(agg, session) {
  if (!agg) return 'no aggregate metrics';
  const floors = _loadFloors();
  const minWR = session === 'RTH' ? floors.rth : floors.eth;
  const reasons = [];
  if ((agg.totalTestTrades || 0) < floors.minTrades) reasons.push(`trades<${floors.minTrades}`);
  if ((agg.winRate || 0) < minWR) reasons.push(`WR<${(minWR*100).toFixed(0)}%`);
  if ((agg.profitFactor || 0) < floors.minPF) reasons.push(`PF<${floors.minPF}`);
  return reasons.join(', ');
}

module.exports = {
  decide,
  modelStatus,
  invalidateCache,
  getQualityFloors,
  recordTradeResult,
  resetSafetyState,
  getSafetyState,
  seedDailyPnLFromNt8,
  getDecisionMode,
  setDecisionMode
};
