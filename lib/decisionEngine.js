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
const { getNewsTradingSuspension } = require('./newsCalendar');

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

// _loadFloors(sym) — returns quality floors for a given symbol.
// If quality_floors.json has a symbolFloors[sym] entry, those override
// the global floors for that symbol only. This lets ES use looser floors
// (55%/53%) while NQ/CL/GC use the strict global floors (60%/58%).
function _loadFloors(sym) {
  try {
    if (fs.existsSync(_FLOORS_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(_FLOORS_FILE, 'utf-8'));
      // Per-symbol override — normalise symbol to mini (MNQ=F → NQ=F)
      const miniSym = sym ? familyMiniSymbol(sym) : null;
      const symOverride = miniSym && cfg.symbolFloors && cfg.symbolFloors[miniSym]
        ? cfg.symbolFloors[miniSym] : null;
      // Merge: symbol override wins for each field it defines, global is the fallback
      return {
        rth:          parseFloat((symOverride && symOverride.rthFloor) || cfg.rthFloor)  || 0.60,
        eth:          parseFloat((symOverride && symOverride.ethFloor) || cfg.ethFloor)  || 0.58,
        minPF:        parseFloat((symOverride && symOverride.minPF)    || cfg.minPF)     || 1.30,
        minSharpe:    parseFloat((symOverride && symOverride.minSharpe) != null
                        ? symOverride.minSharpe
                        : cfg.minSharpe)                                                 || 0.0,
        minTrades:    parseInt((symOverride && symOverride.minTrades) || cfg.minTrades, 10) || 40,
        lastTrainedAt: cfg.lastTrainedAt,
        _overriddenFor: symOverride ? miniSym : null
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

function _passesQualityGate(agg, session, sym) {
  if (!agg) return false;
  // Measurement bypass — BT_NO_GATE=1 ignores the WR/PF/Sharpe floors so a
  // backtest can reveal what a gated bundle WOULD do. Default off; never set live.
  if (process.env.BT_NO_GATE === '1') return (agg.totalTestTrades || 0) >= 10;
  const floors = _loadFloors(sym);   // sym enables per-symbol floor override
  if ((agg.totalTestTrades || 0) < floors.minTrades) return false;
  const minWR = session === 'RTH' ? floors.rth : floors.eth;
  if ((agg.winRate || 0) < minWR) return false;
  if ((agg.profitFactor || 0) < floors.minPF) return false;
  // Sharpe gate: only block if floor > 0 AND model stored a sharpeRatio
  if (floors.minSharpe > 0 && agg.sharpeRatio != null && agg.sharpeRatio < floors.minSharpe) return false;
  return true;
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
// ── CME equity-index trading window (user spec 2026-05-31) ──────────────────
// Trade the FULL session: Sunday 3:00 PM PT (open) → Friday 2:00 PM PT (close).
// Closed only: (a) the daily maintenance break 2:00–3:00 PM PT, and
//              (b) the weekend gap Friday 2:00 PM PT → Sunday 3:00 PM PT.
// No more overnight / deep-Asian / EOD halts — the bot runs around the clock
// while the market is open, per owner request.
function _isMarketClosed(nowMs) {
  const d = new Date(nowMs || Date.now());
  const month = d.getUTCMonth();
  const ptOffset = (month >= 2 && month <= 10) ? 7 : 8;   // PDT=UTC-7, PST=UTC-8
  const pt = new Date(d.getTime() - ptOffset * 3600 * 1000); // shift epoch → read PT via UTC fields
  const dow = pt.getUTCDay();                  // 0=Sun … 5=Fri 6=Sat (PT)
  const hm  = pt.getUTCHours() * 60 + pt.getUTCMinutes();   // minutes since PT midnight
  const OPEN = 15 * 60, CLOSE = 14 * 60;       // 3:00 PM and 2:00 PM PT

  // Daily maintenance break: 2:00–3:00 PM PT (market down every day)
  if (hm >= CLOSE && hm < OPEN) return true;
  // Weekend: Sat all day; Fri ≥ 2 PM; Sun < 3 PM
  if (dow === 6) return true;
  if (dow === 5 && hm >= CLOSE) return true;
  if (dow === 0 && hm < OPEN)  return true;
  return false;
}

// Called by the trade-close pipeline so guards can react.
// bucketKey = e.g. "ES=F_RTH_CHOP_long"
// Pass entryPrice so the price-move guard can compare future bars to it.
function recordTradeResult({ symbol, session, regime, direction, pnl, exitTime, entryPrice }) {
  const s = _safetyState();
  const bucket = `${symbol}_${session}_${regime}_${direction === 'Long' ? 'long' : 'short'}`;
  const todayKey = _etDateKey(exitTime ? new Date(exitTime).getTime() : undefined);

  // Daily P&L roll-up â€” resets at UTC midnight. Keyed by the family/mini symbol
  // (MNQ=F -> NQ=F) so the -$1500 cap works in MICRO mode (audit fix 2026-06-02:
  // write side recorded MNQ=F while the cap check read NQ=F -> never matched).
  const _ddKey = familyMiniSymbol(symbol);
  if (!s.dailyPnL[_ddKey] || s.dailyPnL[_ddKey].date !== todayKey) {
    s.dailyPnL[_ddKey] = { date: todayKey, pnl: 0 };
  }
  s.dailyPnL[_ddKey].pnl += (pnl || 0);

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
  const _ddKey = familyMiniSymbol(symbol);  // mini key so MICRO-mode losses seed the same ledger the cap reads
  const current = (s.dailyPnL[_ddKey] && s.dailyPnL[_ddKey].date === todayKey)
    ? s.dailyPnL[_ddKey].pnl : 0;
  if (current !== 0) return;  // already has data from this session, don't overwrite
  s.dailyPnL[_ddKey] = { date: todayKey, pnl: nt8RealizedPnL };
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

// Persistent per-bundle kill switch (models/disabled_bundles.json). Hot-reloaded
// every 10s. Returns a map of { bundleStem: reasonString }. Empty on any error
// (fail-open — a missing/broken file never blocks trading).
const DISABLED_BUNDLES_FILE = path.join(MODELS_DIR, 'disabled_bundles.json');
let _disabledCache = null;
let _disabledCacheMs = 0;
const _DISABLED_TTL_MS = 10000;
function _loadDisabledBundles() {
  if (_disabledCache && (Date.now() - _disabledCacheMs) < _DISABLED_TTL_MS) return _disabledCache;
  try {
    const obj = JSON.parse(fs.readFileSync(DISABLED_BUNDLES_FILE, 'utf-8'));
    _disabledCache = (obj && obj.disabled) || {};
  } catch (e) {
    _disabledCache = {};
  }
  _disabledCacheMs = Date.now();
  return _disabledCache;
}

// Force-enable list (models/enabled_bundles.json) — lets a vetted bundle bypass
// the WR quality gate (e.g. a PF-4.77 / 50%-WR bundle the 60% floor wrongly
// rejects). DELIBERATELY startup-only (read ONCE per process, no hot-reload):
// ADDING trade exposure must wait for an explicit server restart — the user's
// control point — whereas the disable list hot-reloads because REMOVING a bad
// bundle should take effect immediately. The disable list always wins over this.
const ENABLED_BUNDLES_FILE = path.join(MODELS_DIR, 'enabled_bundles.json');
let _enabledCache = null;
function _loadEnabledBundles() {
  if (_enabledCache !== null) return _enabledCache;   // load once, cache for process lifetime
  try {
    const obj = JSON.parse(fs.readFileSync(ENABLED_BUNDLES_FILE, 'utf-8'));
    _enabledCache = (obj && obj.enabled) || {};
  } catch (e) {
    _enabledCache = {};
  }
  return _enabledCache;
}

// ── Chop guard ──────────────────────────────────────────────────────────────
// Kaufman efficiency ratio over the last n closes: |net move| / total path.
// ~1.0 = clean one-way trend; near 0 = choppy two-way (motion, no progress).
function _efficiencyRatio(candles, n) {
  if (!candles || candles.length < n + 1) return 1;
  const c = candles.slice(-(n + 1));
  const net = Math.abs(c[c.length - 1].close - c[0].close);
  let path = 0;
  for (let i = 1; i < c.length; i++) path += Math.abs(c[i].close - c[i - 1].close);
  return path > 0 ? net / path : 1;
}

// Chop-guard config. env (CHOP_GUARD=1/0, CHOP_ER) wins for A/B backtests;
// otherwise models/chop_guard.json {enabled, erFloor}, hot-reloaded (10s).
const CHOP_GUARD_FILE = path.join(MODELS_DIR, 'chop_guard.json');
let _chopCache = null, _chopCacheMs = 0;
function _loadChopGuard() {
  if (process.env.CHOP_GUARD === '1') return { enabled: true,  erFloor: parseFloat(process.env.CHOP_ER || '0.34') };
  if (process.env.CHOP_GUARD === '0') return { enabled: false, erFloor: 0.34 };
  if (_chopCache && (Date.now() - _chopCacheMs) < 10000) return _chopCache;
  try {
    const o = JSON.parse(fs.readFileSync(CHOP_GUARD_FILE, 'utf-8'));
    _chopCache = { enabled: !!o.enabled, erFloor: (o.erFloor != null ? o.erFloor : 0.34) };
  } catch (e) {
    _chopCache = { enabled: false, erFloor: 0.34 };
  }
  _chopCacheMs = Date.now();
  return _chopCache;
}

// Directional guard config. env (DIR_GUARD=1/0) wins for A/B backtests;
// otherwise models/dir_guard.json {enabled}, hot-reloaded (10s).
const DIR_GUARD_FILE = path.join(MODELS_DIR, 'dir_guard.json');
let _dirCache = null, _dirCacheMs = 0;
function _loadDirGuard() {
  if (process.env.DIR_GUARD === '1') return { enabled: true };
  if (process.env.DIR_GUARD === '0') return { enabled: false };
  if (_dirCache && (Date.now() - _dirCacheMs) < 10000) return _dirCache;
  try {
    const o = JSON.parse(fs.readFileSync(DIR_GUARD_FILE, 'utf-8'));
    _dirCache = { enabled: !!o.enabled };
  } catch (e) {
    _dirCache = { enabled: false };
  }
  _dirCacheMs = Date.now();
  return _dirCache;
}

// Exhaustion guard (ES counter-trend shorts). env EXHAUST_GUARD=1/0 wins for A/B
// backtests; otherwise models/exhaust_guard.json {enabled, adxMin, vwapMin},
// hot-reloaded (10s). Defaults adxMin 30 / vwapMin 4 (the robust setting).
const EXHAUST_GUARD_FILE = path.join(MODELS_DIR, 'exhaust_guard.json');
let _egCache = null, _egCacheMs = 0;
function _loadExhaustGuard() {
  if (process.env.EXHAUST_GUARD === '1') return { enabled: true,  adxMin: 30, vwapMin: 4 };
  if (process.env.EXHAUST_GUARD === '0') return { enabled: false, adxMin: 30, vwapMin: 4 };
  if (_egCache && (Date.now() - _egCacheMs) < 10000) return _egCache;
  try {
    const o = JSON.parse(fs.readFileSync(EXHAUST_GUARD_FILE, 'utf-8'));
    _egCache = { enabled: !!o.enabled, adxMin: o.adxMin != null ? o.adxMin : 30, vwapMin: o.vwapMin != null ? o.vwapMin : 4 };
  } catch (e) {
    _egCache = { enabled: false, adxMin: 30, vwapMin: 4 };
  }
  _egCacheMs = Date.now();
  return _egCache;
}

// Session-quality bar — extra probability margin required for historically
// weak symbol×session buckets (e.g. NQ overnight churn, PF ~1.27 vs RTH 2.4+).
// Concentrates the bot on its high-edge windows instead of churning marginal
// trades that flip negative live. env SESSION_QUALITY (JSON) wins for A/B
// backtests; otherwise models/session_quality.json, hot-reloaded (10s).
// Key = `${symbol}_${session}` (e.g. "NQ=F_ETH"). Value = extra margin (prob).
const SQ_FILE = path.join(MODELS_DIR, 'session_quality.json');
let _sqCache = null, _sqCacheMs = 0;
function _loadSessionQuality() {
  if (process.env.SESSION_QUALITY) {
    try { return JSON.parse(process.env.SESSION_QUALITY); } catch (e) { return {}; }
  }
  if (_sqCache && (Date.now() - _sqCacheMs) < 10000) return _sqCache;
  try { _sqCache = JSON.parse(fs.readFileSync(SQ_FILE, 'utf-8')); }
  catch (e) { _sqCache = {}; }
  _sqCacheMs = Date.now();
  return _sqCache;
}

function _loadModel(symbol, session, regime, direction) {
  const key = `${symbol}|${session}|${regime}|${direction}`;
  const cached = _modelCache.get(key);
  if (cached && (Date.now() - cached.loadedAt) < CACHE_TTL_MS) return cached;

  // Persistent kill-switch list — survives the nightly retrain (the trainer
  // never writes disabled_bundles.json). Honored before reading the bundle so
  // a manual kill always wins over an inflated training WR that the quality
  // gate can't catch. Keyed by bundle stem {MINI}_{SESSION}_{REGIME}_{dir}.
  const stem = `${familyMiniSymbol(symbol).replace('=F', '')}_${session}_${regime}_${direction}`;
  const disabledList = _loadDisabledBundles();
  if (disabledList[stem]) {
    const entry = { missing: false, disabled: true, reason: disabledList[stem], loadedAt: Date.now() };
    _modelCache.set(key, entry);
    return entry;
  }

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

    // Quality gate — refuse to load bundles below the bar so the live engine
    // never trades a known-bad specialist (e.g., ES_RTH_TREND_UP_long 28% WR).
    // Per-session floor: configurable in quality_floors.json; per-symbol overrides
    // supported via symbolFloors (e.g. ES uses 55%/53% vs global 60%/58%).
    // Force-enable (vetted bundle) bypasses the WR floor; disable list already
    // checked above and always wins, so an enabled+disabled stem stays disabled.
    const forceEnabled = !!_loadEnabledBundles()[stem];
    const passes = forceEnabled || _passesQualityGate(obj.aggregate, session, symbol);
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

  // ── CHECK 2: Market-hours gate (Sun 3 PM PT → Fri 2 PM PT, no daily halts) ──
  // Replaces the old deep-Asian + EOD daily halts. The bot now trades the full
  // CME session and only sits out the daily maintenance hour + the weekend gap.
  if (_isMarketClosed()) {
    return { action: 'FLAT', reason: 'market_closed (maintenance/weekend)', regime: 'CLOSED', session, liveFeatures };
  }

  // ── CHECK 2c: High-impact news blackout ──────────────────────────────────
  // Block new entries ±15 min around any High-impact event (CPI, NFP, FOMC).
  // ±5 min is too narrow for FOMC-style volatility spikes; ±15 min gives the
  // initial move time to settle before re-entering.
  // Skipped under BACKTEST=1 — the news feed is wall-clock-relative (today's
  // calendar), so it can't gate historical bars correctly; it would also fire
  // dangling network fetches per bar. Backtests measure raw strategy edge.
  if (!process.env.BACKTEST) {
    try {
      const newsState = getNewsTradingSuspension(15); // 15-min blackout window
      if (newsState.suspensionActive) {
        return { action: 'FLAT', reason: `news_blackout: ${newsState.reason}`, session, liveFeatures };
      }
    } catch (e) { /* non-fatal — never block trading on news-check errors */ }
  }

  // â”€â”€ CHECK 3: Regime must be tradeable â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const regimeInfo = classifyRegime(fv);
  if (!isTradeable(regimeInfo.regime)) {
    return { action: 'FLAT', reason: `regime=${regimeInfo.regime} (${regimeInfo.reason || 'not tradeable'})`, regime: regimeInfo.regime, session, liveFeatures };
  }

  // ── CHECK 3b: Chop guard — skip TREND-following entries in choppy/two-way
  //    conditions. Kaufman efficiency ratio = |net move| / total path over 20
  //    bars; near 0 = lots of motion, no progress = chop (whipsaw risk).
  //    Only gates TREND_UP/TREND_DOWN; VOL_EXPANSION + CHOP bundles are exempt
  //    (they're built for those regimes and win there). Toggle via models/
  //    chop_guard.json {"enabled":true,"erFloor":0.34} (hot-reloaded, no restart).
  if (regimeInfo.regime === 'TREND_UP' || regimeInfo.regime === 'TREND_DOWN') {
    const cg = _loadChopGuard();
    if (cg.enabled) {
      const er = _efficiencyRatio(candles, 20);
      if (er < cg.erFloor) {
        return { action: 'FLAT', reason: `chop_guard (ER=${er.toFixed(2)}<${cg.erFloor})`, regime: regimeInfo.regime, session, liveFeatures };
      }
    }
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

  // Display-only probabilities payload — use null for directions that weren't
  // computed this bar (no usable model).  Internal longProb/shortProb stay as
  // 0 for all arithmetic below; the payload nulls are only for the dashboard
  // so it shows "—" instead of "0%" when a specialist isn't active.
  const _probs = () => ({
    long:    longUsable  ? longProb  : null,
    short:   shortUsable ? shortProb : null,
    longTh:  longUsable  ? longTh   : null,
    shortTh: shortUsable ? shortTh  : null
  });

  // â”€â”€ CHECK 5: Profile threshold cap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Cap is a CEILING only — it prevents model thresholds from being so high
  // that they never fire. It must NEVER push a threshold below its trained
  // walkforward level (that would fire outside the validated edge).
  //
  // ETH -0.05 discount REMOVED 2026-05-28:
  //   The discount was lowering ETH thresholds below training level.
  //   NQ ETH CHOP long trained at 0.72, fired at 0.55 after cap → 0-for-5 live.
  //   ETH models are trained on ETH bars; no session discount needed.
  try {
    const profile = require('./aggressivenessProfile').getActiveProfile();
    if (profile && profile.runtimeThresholdCap != null) {
      const cap = profile.runtimeThresholdCap;  // uniform for RTH and ETH
      if (longUsable  && longTh  > cap) longTh  = cap;
      if (shortUsable && shortTh > cap) shortTh = cap;
    }
  } catch (e) { /* use bundle-baked thresholds */ }

  // â”€â”€ CHECK 6: Daily P&L floor ($1500) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const guards   = _safetyState();
  const todayKey = _etDateKey();
  const _ddKey = familyMiniSymbol(symbol);  // read the same mini-keyed ledger the writers use (MICRO-mode cap fix)
  const todayPnL = (guards.dailyPnL[_ddKey] && guards.dailyPnL[_ddKey].date === todayKey)
    ? guards.dailyPnL[_ddKey].pnl : 0;
  if (todayPnL <= -1500) {
    return { action: 'FLAT', reason: `daily P&L cap hit â€” ${symbol} ${todayPnL.toFixed(0)}`,
      regime: regimeInfo.regime, session: fv.session,
      probabilities: _probs(),
      liveFeatures, blocked: true };
  }

  // Feature snapshot for loss auditor + brain panel
  const featureSnapshot = {};
  fv.names.forEach((n, i) => { featureSnapshot[n] = fv.values[i]; });

  // â”€â”€ CHECK 7: Clean fire check â€” prob >= threshold + 0.02 margin â”€â”€â”€â”€
  // Single margin for both sessions (was 0.02-0.04, now flat 0.02).
  // REMOVED: adaptive threshold, price-move guard, ATR percentile,
  //          EMA agreement, MACD alignment, percentile self-calibration.
  // Those 6 layers compounded to silence the bot even when good bundles
  // were deployed. The trained threshold already encodes the edge â€”
  // adding manual guards above it just removes profitable entries.
  const MARGIN = 0.02;
  // Session-quality bonus: weak symbol×session buckets must clear a higher bar.
  const _sqBonus = _loadSessionQuality()[`${symbol}_${fv.session}`] || 0;
  let longBundleFire  = longUsable  && longProb  >= longTh  + MARGIN + _sqBonus;
  let shortBundleFire = shortUsable && shortProb >= shortTh + MARGIN + _sqBonus;

  // ── Directional guard — don't take TREND-following entries against the
  //    short-term price direction (close vs EMA9). Stops "long into a falling
  //    market" when the TREND_UP regime lags a turn (this morning's NQ bleed),
  //    while still allowing genuine up-trend longs. CHOP/VOL_EXPANSION are
  //    exempt (mean-reversion / breakout). Toggle: models/dir_guard.json.
  const _dg = _loadDirGuard();
  if (_dg.enabled) {
    const e9 = featureSnapshot.ema9_dist;
    if (e9 != null) {
      if (regimeInfo.regime === 'TREND_UP'   && e9 <= 0) longBundleFire  = false;
      if (regimeInfo.regime === 'TREND_DOWN' && e9 >= 0) shortBundleFire = false;
    }
  }

  // ── Exhaustion gate (ES counter-trend shorts) ──────────────────────────
  // ES_TREND_UP_short only pays when fading the MOST over-extended legs, not
  // mid-strength uptrends. Audit 2026-06-02 (feature-level analysis of all 4694
  // entries): require ADX >= adxMin AND price >= vwapMin ATR above VWAP, else
  // block the short. Lifts ES_TREND_UP_short PF 0.92 (-$46k) -> ~1.21 (+$25k),
  // positive every year, smooth monotonic PF surface (real edge, not curve-fit).
  // Toggle: models/exhaust_guard.json {enabled, adxMin, vwapMin}; env EXHAUST_GUARD.
  const _eg = _loadExhaustGuard();
  if (_eg.enabled && regimeInfo.regime === 'TREND_UP' && symbol.startsWith('ES')) {
    const a = featureSnapshot.adx, v = featureSnapshot.vwap_dev_atr;
    if (a != null && v != null && !(a >= _eg.adxMin && v >= _eg.vwapMin)) {
      shortBundleFire = false;
    }
  }

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
    entry.probabilities = _probs();
    return entry;
  }
  if (longSignal) {
    const entry = _buildEntry('BUY', symbol, fv, longProb, longTh, regimeInfo, slAtrMult, tpAtrMult, featureSnapshot);
    entry.probabilities = _probs();
    return entry;
  }
  if (shortSignal) {
    const entry = _buildEntry('SELL', symbol, fv, shortProb, shortTh, regimeInfo, slAtrMult, tpAtrMult, featureSnapshot);
    entry.probabilities = _probs();
    return entry;
  }

  // FLAT â€” nothing fired or LLM blocked
  const reason = llmReason || `below threshold (L=${longProb.toFixed(2)}<${(longTh+MARGIN).toFixed(2)}, S=${shortProb.toFixed(2)}<${(shortTh+MARGIN).toFixed(2)})`;
  return {
    action:       'FLAT',
    reason,
    regime:       regimeInfo.regime,
    session:      fv.session,
    probabilities:_probs(),
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
      const enabled = _passesQualityGate(obj.aggregate, obj.session, obj.symbol);
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
        gateReason: enabled ? null : _gateRejectReason(obj.aggregate, obj.session, obj.symbol)
      };
    } catch (e) {
      return { file: f, error: e.message, enabled: false };
    }
  });
}

function _gateRejectReason(agg, session, sym) {
  if (!agg) return 'no aggregate metrics';
  const floors = _loadFloors(sym);
  const minWR = session === 'RTH' ? floors.rth : floors.eth;
  const reasons = [];
  if ((agg.totalTestTrades || 0) < floors.minTrades) reasons.push(`trades<${floors.minTrades}`);
  if ((agg.winRate || 0) < minWR) reasons.push(`WR<${(minWR*100).toFixed(0)}%`);
  if ((agg.profitFactor || 0) < floors.minPF) reasons.push(`PF<${floors.minPF}`);
  if (floors.minSharpe > 0 && agg.sharpeRatio != null && agg.sharpeRatio < floors.minSharpe)
    reasons.push(`Sharpe<${floors.minSharpe}`);
  return reasons.join(', ') || 'unknown';
}

module.exports = {
  decide,
  modelStatus,
  invalidateCache,
  getQualityFloors,
  recordTradeResult,
  resetSafetyState,
  getSafetyState,
  seedDailyPnLFromNt8
};
