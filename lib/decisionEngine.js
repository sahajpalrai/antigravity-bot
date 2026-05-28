// Antigravity v2 â€” Live Decision Engine
// Brings everything together: a stream of candles in â†’ BUY / SELL / FLAT signal out.
// Loads trained GBDT models from models/ folder, runs feature extraction â†’
// regime classification â†’ routed model prediction â†’ threshold gating â†’
// position sizing â†’ exit levels.

'use strict';

const fs = require('fs');
const path = require('path');
const { buildFeatures, sessionFromTimestamp } = require('./featureEngineer');
const { classifyRegime, isTradeable } = require('./regimeClassifier');
const { predict, deserialize, predictLgbm } = require('./gbdtModel');
const { familyMiniSymbol, CONTRACT_SPECS } = require('./paperEngine');
const { fixedExitsFor } = require('./exitsConfig');
const llmAnalyst = require('./llmAnalyst');

const MODELS_DIR = path.join(__dirname, '..', 'models');

// Quality gate â€” bundles whose walkforward aggregate fails these thresholds are
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

// â”€â”€ Fair Value Gap (FVG) detector â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FVG = 3-candle imbalance pattern. The "money maker" from V5.
//   Bullish FVG: candle[i-2].high < candle[i].low â†’ gap between them
//                (a wick is left unfilled â€” buyers in control)
//   Bearish FVG: candle[i-2].low  > candle[i].high â†’ gap below
//
// We scan the most recent 20 bars for the most-recent UNFILLED FVG and
// check whether current price is RETURNING to it (within 1Ã—ATR of the gap).
// When price returns to an unfilled FVG, that level usually holds and the
// move resumes â€” classic V5 setup that backtests at 65-70% WR alone.
//
// Returns: { dir: 'bull'|'bear'|null, strength: 0..1, atrFromGap: N }
function _detectFVG(candles, fv) {
  if (!candles || candles.length < 25) return { dir: null, strength: 0 };
  const atr = fv.atr || 0;
  if (atr <= 0) return { dir: null, strength: 0 };
  const last = candles[candles.length - 1];
  const lookback = 20;
  const startIdx = Math.max(2, candles.length - lookback);

  // Scan from most recent backwards. First unfilled FVG within 1Ã—ATR wins.
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
      // Is price returning to the gap (within 1Ã—ATR of gapTop)?
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

// â”€â”€ DECISION MODE TOGGLE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// User flips between 'HYBRID' (V2 bundle + V5 committee with veto rule)
// and 'V2' (bundle path only â€” V5 modules become display-only). Live
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

// â”€â”€ V5 money-maker module detectors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Ported as CONFLUENCE BOOSTERS (not signal generators) â€” each returns
// { dir: 'bull'|'bear'|null, strength: 0..1, type }. The decision engine
// stacks aligned boosters to relax the prob margin; the more boosters
// agree with the bundle's direction, the easier it fires.
//
// Sources:
//   V5/Python/nq/v5_strategies.py:
//     1027 score_nq_pro, 1062 try_nq_pro_trade  â†’ NQ_PRO
//     2225 score_ver,    2323 try_ver_trade      â†’ VER (~70% WR)
//     1324 score_htf_break, 1343 try_htf_break  â†’ HTF_BREAK (~55-60% WR)
//     1409 score_daily_level, 1432 try_daily    â†’ DAILY_LEVEL (6W/0L logged)
//     1705 score_ema_raschke, 1713 try_raschke  â†’ EMA_RASCHKE (5W/0L morning)

// Session VWAP â€” volume-weighted typical price over the recent window.
// 80 bars Ã— 5 min = ~6.7 hours, roughly covers one trading session.
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

// NQ_PRO â€” MACD-direction + 4-check confluence (V5 winner after b2850e6 revert).
// LONG: macd_line>0, macd_hist>0, AND â‰¥3 of {ema_stack_up, above_VWAP, RSI 40-70, vol > avg}.
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

// VER â€” VWAP + EMA9 Reclaim (~70% WR per V5 comment).
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

// HTF_BREAK â€” 15-min equivalent break + retest (~55-60% WR per V5 comment).
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

  // LONG break: closed above htfHigh, within 0.5Ã—ATR (= retest zone)
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

// DAILY_LEVEL â€” previous-day high/low break (V5 logged 6W/0L +$380).
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
  // LONG: closed above PDH within 1Ã—ATR of the break (continuation zone)
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

// EMA_RASCHKE â€” Linda "Holy Grail" â€” pullback to EMA9 in strong-ADX trend,
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

// Confluence dispatcher â€” runs all 6 V5 detectors + sums aligned strengths.
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

// â”€â”€ Runtime safety state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
// trades between 5 PM PT and midnight PT (midnight UTC â†’ 8 PM UTC) don't roll
// the daily key to the next calendar day. All three daily-P&L checkpoints
// (recordTradeResult, seedDailyPnLFromNt8, Guard 5) must use this same function.
function _etDateKey(ts) {
  const d = new Date(ts || Date.now());
  const et = new Date(d.getTime() - 4 * 60 * 60 * 1000);  // EDT = UTC-4
  return et.toISOString().slice(0, 10);
}

// Deep Asian session gate â€” 10 PM to 2 AM ET.
// Research convergence from 4 independent sources (Edgeful ETH/RTH study,
// TRADEPRO Academy overnight guide, prop firm docs, V6 loss audit):
//   â€¢ NQ/ES volume drops to ~10% of RTH during this window
//   â€¢ Spread widens to 0.5â€“1.25 pts (NQ)
//   â€¢ 40% false-breakout rate for NQ overnight; worst in deep Asian hours
//   â€¢ V6 overnight -$1,200+ loss on 2026-05-18 was T3 drought forcing trades
//     exactly into this window (8 PM ET) against a 160-pt NQ bounce.
// ETH signals are allowed in the London pre-open (2â€“5 AM ET) and US evening
// (6â€“10 PM ET) windows, which have measurably better liquidity.
function _isDeepAsianWindow(nowMs) {
  const d = new Date(nowMs || Date.now());
  // Approximate DST: March (2) through October (10) = EDT (UTC-4); else EST (UTC-5)
  const month   = d.getUTCMonth();
  const offset  = (month >= 2 && month <= 10) ? 4 : 5;   // hours behind UTC
  const etHour  = (d.getUTCHours() - offset + 24) % 24;  // 0â€“23 ET
  return etHour >= 22 || etHour < 2;                      // 10 PM â€“ 1:59 AM ET
}

// Called by the trade-close pipeline so guards can react.
// bucketKey = e.g. "ES=F_RTH_CHOP_long"
// Pass entryPrice so the price-move guard can compare future bars to it.
function recordTradeResult({ symbol, session, regime, direction, pnl, exitTime, entryPrice }) {
  const s = _safetyState();
  const bucket = `${symbol}_${session}_${regime}_${direction === 'Long' ? 'long' : 'short'}`;
  const todayKey = _etDateKey(exitTime ? new Date(exitTime).getTime() : undefined);

  // Daily P&L roll-up â€” resets at UTC midnight
  if (!s.dailyPnL[symbol] || s.dailyPnL[symbol].date !== todayKey) {
    s.dailyPnL[symbol] = { date: todayKey, pnl: 0 };
  }
  s.dailyPnL[symbol].pnl += (pnl || 0);

  if (pnl < 0) {
    // LOSS â€” arm the price-move guard with this loss's entry price.
    // Bump loss counter (adaptive threshold tightens). Wipe win credit
    // so any earned trust is lost.
    s.lastLossAt[bucket]    = Date.now();
    s.lastLossPrice[bucket] = entryPrice != null ? entryPrice : null;
    s.lossStreak[bucket]    = (s.lossStreak[bucket] || 0) + 1;
    s.winStreak[bucket]     = 0;
  } else {
    // WIN â€” clear the price-move guard AND DECREMENT (not reset) the
    // loss streak. A win earns one unit of forgiveness but a 5-loss
    // streak isn't fully erased by a single win. Recovery is earned
    // gradually, the same way the penalty accumulated.
    //
    // Trajectory example (trained_th = 0.65, +0.02/loss, -0.015/win):
    //   5 losses          â†’ L=5 W=0 â†’ delta +0.10 â†’ effective 0.75
    //   5L then 1W        â†’ L=4 W=1 â†’ delta +0.065 â†’ effective 0.715
    //   5L then 2W        â†’ L=3 W=2 â†’ delta +0.030 â†’ effective 0.680
    //   5L then 3W        â†’ L=2 W=3 â†’ 0 (clamped) â†’ effective 0.650 (recovered)
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
  // Micros piggyback on mini models â€” same underlying price, same edge.
  // MNQ=F â†’ NQ_RTH_VOL_EXPANSION_short.json
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

    // Manual kill switch â€” bundle JSON can carry `"disabled": true` to take
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

    // Quality gate â€” refuse to load bundles below the bar so the live engine
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

    // lgbm models: store raw obj for predictLgbm. Legacy gbdt-binary: deserialize.
    const model = (obj.type === 'lgbm') ? obj : deserialize(obj);
    const modelType = obj.type || 'gbdt-binary';
    const entry = {
      model,
      modelType,
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

// â”€â”€â”€ Percentile threshold â€” self-calibrating per bundle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Keeps a rolling buffer of the last 100 raw GBDT probabilities per bundle.
// When the live score distribution compresses (e.g., ETH overnight probs cluster
// at 0.49â€“0.52), the 70th percentile of recent scores drops to ~0.515 â€” meaning
// the effective threshold adapts down automatically without manual patching.
// A hard floor (0.48) ensures we never fire on true coin-flip signals.
//
// Research source: "Dynamic Calibration of Decision Thresholds for Financial
// Anomaly Detection" (2024) + Agent 2 drift research sweep 2026-05-28.
const _SCORE_BUF_SIZE   = 100;
const _SCORE_BUF_PCTILE = 0.70;   // fire if score is in top 30% of recent scores
const _SCORE_BUF_FLOOR  = 0.48;   // absolute floor â€” never fire below this
const _scoreBuffers     = new Map();  // bundleKey â†’ number[]

function _recordScore(bundleKey, score) {
  if (!_scoreBuffers.has(bundleKey)) _scoreBuffers.set(bundleKey, []);
  const buf = _scoreBuffers.get(bundleKey);
  buf.push(score);
  if (buf.length > _SCORE_BUF_SIZE) buf.shift();
}

// Returns the adaptive threshold if buffer has â‰¥ 20 samples, else null (use static).
function _percentileTh(bundleKey) {
  const buf = _scoreBuffers.get(bundleKey);
  if (!buf || buf.length < 20) return null;
  const sorted = [...buf].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * _SCORE_BUF_PCTILE);
  return Math.max(sorted[idx], _SCORE_BUF_FLOOR);
}

// â”€â”€â”€ Public: produce a decision from a candle window â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Returns one of:
//   { action: 'FLAT', reason: '...', regime, session }
//   { action: 'BUY' | 'SELL', symbol, probability, threshold, regime, session,
//     atr, close, tpDistance, slDistance, featureSnapshot }

// â”€â”€â”€ Simplified decide() â€” Track B redesign 2026-05-28 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Old engine: 15 stacking blocking layers â†’ bot silenced even with good signals.
// New engine: 7 essential checks + LLM analyst as context confirmation.
//
// Removed guards (7):
//   - Adaptive threshold (death-spiral: each loss raises bar, bot never recovers)
//   - Price-move confirmation after loss (fearful, not logical; model already priced losses)
//   - ATR sweet-spot percentile filter (over-fitted backtest artifact)
//   - EMA stack agreement guard (GBDT already trained on EMA features)
//   - MACD momentum guard (GBDT already trained on MACD features)
//   - Percentile threshold auto-calibration (adds noise, not signal)
//   - HYBRID V5 committee path (replaced by LLM analyst â€” smarter, simpler)
//
// Kept (7):
//   1. Feature build check
//   2. Deep Asian session block (10 PMâ€“2 AM ET â€” genuine low-quality window)
//   3. Regime tradeable check
//   4. Quality gate (bundle deployed by walkforward)
//   5. Profile threshold cap
//   6. Daily P&L floor ($1500)
//   7. Single clean fire check: prob >= threshold + 0.02 margin
//
// Added (1):
//   + LLM analyst gate â€” confirm direction with market context
//     On unavailable/error: fall through to GBDT-only path
function decide(symbol, candles, opts = {}) {
  const fv = buildFeatures(candles, { symbol });
  if (!fv) return { action: 'FLAT', reason: 'insufficient_history' };

  // Feature snapshot â€” shown on every decision for dashboard cards + brain panel
  const liveFeatures = {
    adx:       fv.values[fv.names.indexOf('adx')],
    rsi:       fv.values[fv.names.indexOf('rsi')],
    macd_hist: fv.values[fv.names.indexOf('macd_hist')],
    bb_z:      fv.values[fv.names.indexOf('bb_z')],
    atr_pct:   fv.values[fv.names.indexOf('atr_pct')],
    close:     fv.close,
    session:   fv.session
  };

  const session = fv.session;

  // â”€â”€ CHECK 2: Deep Asian block (10 PMâ€“2 AM ET) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (session === 'ETH' && _isDeepAsianWindow()) {
    return { action: 'FLAT', reason: 'deep_asian_block (10 PM-2 AM ET)', regime: 'ETH_DEEP_ASIAN', session, liveFeatures };
  }

  // â”€â”€ CHECK 3: Regime must be tradeable â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const regimeInfo = classifyRegime(fv);
  if (!isTradeable(regimeInfo.regime)) {
    return { action: 'FLAT', reason: `regime=${regimeInfo.regime} (${regimeInfo.reason || 'not tradeable'})`, regime: regimeInfo.regime, session, liveFeatures };
  }

  // â”€â”€ CHECK 4: Quality gate â€” load deployed models â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const longEntry  = _loadModel(symbol, fv.session, regimeInfo.regime, 'long');
  const shortEntry = _loadModel(symbol, fv.session, regimeInfo.regime, 'short');
  const longUsable  = longEntry  && !longEntry.missing  && !longEntry.disabled;
  const shortUsable = shortEntry && !shortEntry.missing && !shortEntry.disabled;

  if (!longUsable && !shortUsable) {
    const why = (longEntry && longEntry.disabled) || (shortEntry && shortEntry.disabled)
      ? `bundle disabled by quality gate for ${fv.session}/${regimeInfo.regime}`
      : `no deployed bundle for ${fv.session}/${regimeInfo.regime}`;
    return { action: 'FLAT', reason: why, regime: regimeInfo.regime, session: fv.session,
      longBundle:  longEntry  && longEntry.disabled  ? 'DISABLED' : (longEntry  && longEntry.missing  ? 'MISSING' : 'OK'),
      shortBundle: shortEntry && shortEntry.disabled ? 'DISABLED' : (shortEntry && shortEntry.missing ? 'MISSING' : 'OK'),
      liveFeatures };
  }

  // Dispatch to LightGBM or custom GBDT depending on trainer that produced the bundle
  const _predictFn = (entry) => entry.modelType === 'lgbm' ? predictLgbm(entry.model, fv.values) : predict(entry.model, fv.values);
  let longProb = 0, shortProb = 0;
  let longTh = 0.65, shortTh = 0.65;
  if (longUsable)  { longProb  = _predictFn(longEntry);  longTh  = longEntry.threshold; }
  if (shortUsable) { shortProb = _predictFn(shortEntry); shortTh = shortEntry.threshold; }

  // â”€â”€ CHECK 5: Profile threshold cap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  try {
    const profile = require('./aggressivenessProfile').getActiveProfile();
    if (profile && profile.runtimeThresholdCap != null) {
      const cap = (session === 'ETH' && profile.runtimeThresholdCap > 0.48)
        ? profile.runtimeThresholdCap - 0.05
        : profile.runtimeThresholdCap;
      if (longUsable  && longTh  > cap) longTh  = cap;
      if (shortUsable && shortTh > cap) shortTh = cap;
    }
  } catch (e) { /* use bundle-baked thresholds */ }

  // â”€â”€ CHECK 6: Daily P&L floor ($1500) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const guards   = _safetyState();
  const todayKey = _etDateKey();
  const todayPnL = (guards.dailyPnL[symbol] && guards.dailyPnL[symbol].date === todayKey)
    ? guards.dailyPnL[symbol].pnl : 0;
  if (todayPnL <= -1500) {
    return { action: 'FLAT', reason: `daily P&L cap hit â€” ${symbol} ${todayPnL.toFixed(0)}`,
      regime: regimeInfo.regime, session: fv.session,
      probabilities: { long: longProb, short: shortProb, longTh, shortTh },
      liveFeatures, blocked: true };
  }

  // Feature snapshot for loss auditor + brain panel
  const featureSnapshot = {};
  fv.names.forEach((n, i) => { featureSnapshot[n] = fv.values[i]; });

  // V5 confluence â€” display-only, NOT a gate (kept for dashboard cards)
  const confluence = _computeConfluence(candles, fv);
  featureSnapshot._confluence = {
    bullScore: confluence.bullScore, bearScore: confluence.bearScore,
    bullNames: confluence.bullNames, bearNames: confluence.bearNames
  };
  const fvgBooster = confluence.boosters.find(b => b.name === 'FVG');
  featureSnapshot._fvg = fvgBooster && fvgBooster.dir
    ? { dir: fvgBooster.dir, strength: fvgBooster.strength } : null;

  // â”€â”€ CHECK 7: Clean fire check â€” prob >= threshold + 0.02 margin â”€â”€â”€â”€
  // Single margin for both sessions (was 0.02-0.04, now flat 0.02).
  // REMOVED: adaptive threshold, price-move guard, ATR percentile,
  //          EMA agreement, MACD alignment, percentile self-calibration.
  // Those 6 layers compounded to silence the bot even when good bundles
  // were deployed. The trained threshold already encodes the edge â€”
  // adding manual guards above it just removes profitable entries.
  const MARGIN = 0.02;
  const longBundleFire  = longUsable  && longProb  >= longTh  + MARGIN;
  const shortBundleFire = shortUsable && shortProb >= shortTh + MARGIN;

  // â”€â”€ LLM ANALYST GATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Reads the pre-fetched signal from the previous bar's async LLM call.
  // If LLM unavailable (null, error, timeout) â†’ fall through to GBDT-only.
  // If LLM says FLAT â†’ block both sides.
  // If LLM disagrees direction â†’ block the conflicting side only.
  let longBlocked  = false;
  let shortBlocked = false;
  let llmReason    = '';

  const llmSignal = llmAnalyst.getLastSignal(symbol);
  if (llmSignal && llmSignal.source === 'llm') {
    const llmAct = llmSignal.action;  // 'LONG' | 'SHORT' | 'FLAT'
    if (llmAct === 'FLAT') {
      longBlocked  = true;
      shortBlocked = true;
      llmReason    = `LLM: FLAT (conf=${llmSignal.confidence.toFixed(2)}) â€” ${llmSignal.reasoning}`;
    } else if (llmAct === 'SHORT' && longBundleFire) {
      longBlocked = true;
      llmReason   = `LLM disagrees: SHORT vs bundle LONG (LLM conf=${llmSignal.confidence.toFixed(2)})`;
    } else if (llmAct === 'LONG' && shortBundleFire) {
      shortBlocked = true;
      llmReason    = `LLM disagrees: LONG vs bundle SHORT (LLM conf=${llmSignal.confidence.toFixed(2)})`;
    }
    featureSnapshot._llm = {
      action:     llmSignal.action,
      confidence: llmSignal.confidence,
      reasoning:  llmSignal.reasoning,
      latencyMs:  llmSignal.latencyMs
    };
  }

  featureSnapshot._signalSource  = (longBundleFire && !longBlocked) || (shortBundleFire && !shortBlocked) ? 'BUNDLE' : null;
  featureSnapshot._qtyMultiplier = 1.0;
  featureSnapshot._v5Override    = null;

  const longSignal  = longBundleFire  && !longBlocked;
  const shortSignal = shortBundleFire && !shortBlocked;

  // R:R from active profile
  let profile2;
  try { profile2 = require('./aggressivenessProfile').getActiveProfile(); } catch (e) { profile2 = null; }
  const tpR      = opts.tpR || (profile2 && profile2.tpR)      || 1.8;
  const slR      = opts.slR || (profile2 && profile2.slR)      || 1.0;
  const slAtrMult = (profile2 && profile2.slAtrMult) || 1.5;
  const tpAtrMult = (profile2 && profile2.tpAtrMult) || (1.5 * tpR / slR);

  // Conflict: both fire â†’ higher margin wins
  if (longSignal && shortSignal) {
    const side = (longProb - longTh) >= (shortProb - shortTh) ? 'BUY' : 'SELL';
    const entry = _buildEntry(side, symbol, fv, side === 'BUY' ? longProb : shortProb, side === 'BUY' ? longTh : shortTh, regimeInfo, slAtrMult, tpAtrMult, featureSnapshot);
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

  // FLAT â€” nothing fired or LLM blocked
  const reason = llmReason || `below threshold (L=${longProb.toFixed(2)}<${(longTh+MARGIN).toFixed(2)}, S=${shortProb.toFixed(2)}<${(shortTh+MARGIN).toFixed(2)})`;
  return {
    action:       'FLAT',
    reason,
    regime:       regimeInfo.regime,
    session:      fv.session,
    probabilities:{ long: longProb, short: shortProb, longTh, shortTh },
    confluence:   featureSnapshot._confluence || null,
    fvg:          featureSnapshot._fvg || null,
    llm:          featureSnapshot._llm || null,
    featureSnapshot,   // included so server.js LLM prefetch fires on FLAT bars too
    liveFeatures
  };
}

// â”€â”€ Track B simplification 2026-05-28: 7 guards removed (see llmAnalyst.js) â”€â”€
function _buildEntry(action, symbol, fv, prob, threshold, regimeInfo, slAtrMult, tpAtrMult, snapshot) {
  // Per-SYMBOL Ã— per-session fixed exit override â€” set via Exits tab.
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
    v5Override: snapshot._v5Override || null,  // legacy field â€” always null now
    qtyMultiplier: snapshot._qtyMultiplier || 1.0,  // 1.0 bundle / 0.8 hybrid
    featureSnapshot: snapshot,
    timestamp: fv.ts
  };
}

// Returns a snapshot of every available model for the dashboard.
// `enabled` reflects the quality gate â€” disabled bundles are listed but
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
