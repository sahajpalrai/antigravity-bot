// Antigravity — Gate 2 Engine
// Pattern-based signal engine with ML confidence filter.
// Called by server.js when activeGate === 'gate2', or for shadow logging
// when shadowGate2 === true (Gate 1 live, Gate 2 records what it would have done).
//
// Signal pipeline:
//   Features → Regime → Session/EOD gate → Pattern Engine (HTTP) → ML Filter → Direction gate → Decision
//
// Pattern engine runs as a separate Python Flask service (gate2/scripts/pattern_engine.py)
// on http://localhost:3100. Start it via gate2/scripts/start_pattern_engine.bat.

'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { buildFeatures } = require('./featureEngineer');
const { classifyRegime, isTradeable } = require('./regimeClassifier');

const GATE2_CONFIG_FILE = path.join(__dirname, '..', 'gate2', 'config.json');
const SHADOW_LOG_FILE   = path.join(__dirname, '..', 'gate2', 'shadow_log.json');
const SHADOW_LOG_MAX    = 2000;  // keep last 2000 shadow entries

// ── Per-symbol runtime state ──────────────────────────────────────────────────
const _cooldownState = {};  // symbol → { lastSignalMs, lastDirection, lockUntilMs }

function _getState(symbol) {
  if (!_cooldownState[symbol]) {
    _cooldownState[symbol] = { lastSignalMs: 0, lastDirection: null, lockUntilMs: 0 };
  }
  return _cooldownState[symbol];
}

// ── Config loader (hot-reload — no restart needed) ────────────────────────────
let _configCache    = null;
let _configCacheMs  = 0;
const CONFIG_TTL_MS = 5000;

function _loadConfig() {
  if (_configCache && (Date.now() - _configCacheMs) < CONFIG_TTL_MS) return _configCache;
  try {
    _configCache   = JSON.parse(fs.readFileSync(GATE2_CONFIG_FILE, 'utf-8'));
    _configCacheMs = Date.now();
  } catch (e) {
    _configCache = {
      rthThreshold: 0.55, ethThreshold: 0.53,
      cooldownMs: 120000, directionLockMs: 600000,
      fvgBypassMlAfterTrades: 100, maxDailyLoss: 500,
      patternEngineUrl: 'http://localhost:3100/analyze'
    };
  }
  return _configCache;
}

// ── Shadow log writer ─────────────────────────────────────────────────────────
function _writeShadowLog(entry) {
  try {
    let log = [];
    if (fs.existsSync(SHADOW_LOG_FILE)) {
      try { log = JSON.parse(fs.readFileSync(SHADOW_LOG_FILE, 'utf-8')); } catch (e) {}
    }
    if (!Array.isArray(log)) log = [];
    log.push(entry);
    if (log.length > SHADOW_LOG_MAX) log = log.slice(-SHADOW_LOG_MAX);
    // Atomic write via temp file
    const tmp = SHADOW_LOG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(log, null, 2));
    fs.renameSync(tmp, SHADOW_LOG_FILE);
  } catch (e) { /* non-fatal */ }
}

// ── Pattern engine HTTP call ──────────────────────────────────────────────────
function _callPatternEngine(symbol, session, regime, candles, features) {
  return new Promise((resolve, reject) => {
    const cfg = _loadConfig();
    const url = new URL(cfg.patternEngineUrl || 'http://localhost:3100/analyze');

    // Send last 50 candles only — enough for all patterns, keeps payload small
    const payload = JSON.stringify({
      symbol, session, regime,
      candles: candles.slice(-50),
      features
    });

    const options = {
      hostname: url.hostname,
      port:     parseInt(url.port || 3100),
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Pattern engine response parse error: ${e.message}`)); }
      });
    });

    req.setTimeout(2500, () => {
      req.destroy();
      reject(new Error('Pattern engine timeout (2.5s)'));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Session + time helpers (mirrors decisionEngine.js) ────────────────────────
function _isDeepAsianWindow() {
  const d = new Date();
  const month  = d.getUTCMonth();
  const offset = (month >= 2 && month <= 10) ? 4 : 5;
  const etHour = (d.getUTCHours() - offset + 24) % 24;
  return etHour >= 22 || etHour < 2;
}

function _isEodHalt() {
  const d       = new Date();
  const month   = d.getUTCMonth();
  const offset  = (month >= 2 && month <= 10) ? 4 : 5;
  const etHour  = (d.getUTCHours() - offset + 24) % 24;
  const etMin   = d.getUTCMinutes();
  const etTotal = etHour * 60 + etMin;
  return etTotal >= 16 * 60 + 45 && etTotal < 18 * 60;
}

// ── Daily P&L tracker for Gate 2 ─────────────────────────────────────────────
const _gate2DailyPnL = {};

function _checkDailyLoss(symbol) {
  const cfg     = _loadConfig();
  const cap     = cfg.maxDailyLoss || 500;
  const today   = new Date().toISOString().slice(0, 10);
  const entry   = _gate2DailyPnL[symbol];
  if (entry && entry.date === today && entry.loss >= cap) return true;
  return false;
}

function recordGate2TradeResult(symbol, pnl) {
  const today = new Date().toISOString().slice(0, 10);
  if (!_gate2DailyPnL[symbol] || _gate2DailyPnL[symbol].date !== today) {
    _gate2DailyPnL[symbol] = { date: today, loss: 0 };
  }
  if (pnl < 0) _gate2DailyPnL[symbol].loss += Math.abs(pnl);
}

// ── Main decision function ────────────────────────────────────────────────────
async function decide2(symbol, candles, opts = {}) {
  // ── Feature build ──
  const fv = buildFeatures(candles, { symbol });
  if (!fv) return { action: 'FLAT', reason: 'insufficient_history', gate: 'gate2' };

  const session = fv.session;

  // ── Session gates ──
  if (session === 'ETH' && _isDeepAsianWindow()) {
    return { action: 'FLAT', reason: 'deep_asian_block (10 PM-2 AM ET)', gate: 'gate2', session };
  }
  if (_isEodHalt()) {
    return { action: 'FLAT', reason: 'eod_halt (4:45-6:00 PM ET)', gate: 'gate2', session };
  }

  // ── Regime gate ──
  const regimeInfo = classifyRegime(fv);
  if (!isTradeable(regimeInfo.regime)) {
    return {
      action: 'FLAT', reason: `regime=${regimeInfo.regime}`,
      regime: regimeInfo.regime, session, gate: 'gate2'
    };
  }

  // ── Daily loss cap ──
  if (_checkDailyLoss(symbol)) {
    return { action: 'FLAT', reason: 'gate2 daily loss cap hit', gate: 'gate2', session };
  }

  // ── Build feature map ──
  const features = {};
  fv.names.forEach((n, i) => { features[n] = fv.values[i]; });

  // ── Call pattern engine ──
  let patternResult;
  try {
    patternResult = await _callPatternEngine(symbol, session, regimeInfo.regime, candles, features);
  } catch (e) {
    // Pattern engine unavailable — return FLAT (never trade without patterns)
    return {
      action: 'FLAT', reason: `pattern_engine_unavailable: ${e.message}`,
      regime: regimeInfo.regime, session, gate: 'gate2'
    };
  }

  // ── Pattern returned FLAT ──
  if (!patternResult || patternResult.signal === 'FLAT') {
    return {
      action: 'FLAT', reason: 'no_pattern_fired',
      regime: regimeInfo.regime, session, gate: 'gate2',
      patterns: patternResult ? patternResult.patterns : {}
    };
  }

  const cfg         = _loadConfig();
  const mlThreshold = session === 'RTH' ? cfg.rthThreshold : cfg.ethThreshold;
  const mlLong      = patternResult.ml_long_prob  || 0.5;
  const mlShort     = patternResult.ml_short_prob || 0.5;
  const agreeing    = patternResult.agreeing_count || 1;
  const patName     = patternResult.pattern;
  const signal      = patternResult.signal;  // 'BUY' or 'SELL'
  const mlTrained   = patternResult.ml_trained === true;

  // ── ML confidence filter ──
  // FVG bypass: after 100+ live trades at 60%+ WR, FVG earns autonomy
  const fvgFired    = patternResult.patterns && patternResult.patterns.FVG === signal;
  const fvgLive     = patternResult.fvg_live_trades || 0;
  const fvgBypass   = fvgFired && fvgLive >= cfg.fvgBypassMlAfterTrades;

  if (mlTrained && !fvgBypass) {
    const prob = signal === 'BUY' ? mlLong : mlShort;

    // Strict block: prob < threshold AND fewer than 2 patterns agree
    if (prob < mlThreshold && agreeing < 2) {
      return {
        action: 'FLAT',
        reason: `ML filtered (${signal} prob=${prob.toFixed(2)}<${mlThreshold}, only ${agreeing} pattern${agreeing === 1 ? '' : 's'})`,
        regime: regimeInfo.regime, session, gate: 'gate2',
        patterns: patternResult.patterns
      };
    }
    // Soft block: prob between 0.50 and threshold — need 2+ patterns
    if (prob < mlThreshold && agreeing >= 2) {
      // 2+ patterns agree at prob ≥ 0.50 — allow through (consensus beats weak ML block)
      console.log(`[Gate2] ${signal} passes by 2-pattern consensus (prob=${prob.toFixed(2)}, agreeing=${agreeing})`);
    }
  }

  // ── Regime direction gate ──
  if (signal === 'BUY' && regimeInfo.regime === 'TREND_DOWN' && agreeing < 2) {
    return {
      action: 'FLAT',
      reason: `TREND_DOWN: counter-trend LONG needs 2+ patterns (got ${agreeing})`,
      regime: regimeInfo.regime, session, gate: 'gate2'
    };
  }
  if (signal === 'SELL' && regimeInfo.regime === 'TREND_UP' && agreeing < 2) {
    return {
      action: 'FLAT',
      reason: `TREND_UP: counter-trend SHORT needs 2+ patterns (got ${agreeing})`,
      regime: regimeInfo.regime, session, gate: 'gate2'
    };
  }
  if (regimeInfo.regime === 'VOL_EXPANSION' && mlTrained) {
    const prob = signal === 'BUY' ? mlLong : mlShort;
    if (prob < mlThreshold) {
      return {
        action: 'FLAT',
        reason: `VOL_EXPANSION: ML agree required (prob=${prob.toFixed(2)}<${mlThreshold})`,
        regime: regimeInfo.regime, session, gate: 'gate2'
      };
    }
  }

  // ── Cooldown + direction lock ──
  const now   = Date.now();
  const st    = _getState(symbol);

  if (now - st.lastSignalMs < cfg.cooldownMs) {
    const remain = Math.round((cfg.cooldownMs - (now - st.lastSignalMs)) / 1000);
    return {
      action: 'FLAT', reason: `cooldown (${remain}s left)`,
      regime: regimeInfo.regime, session, gate: 'gate2'
    };
  }

  if (now < st.lockUntilMs && st.lastDirection !== signal) {
    return {
      action: 'FLAT', reason: `direction lock (last=${st.lastDirection}, want=${signal})`,
      regime: regimeInfo.regime, session, gate: 'gate2'
    };
  }

  // ── FIRE — update state ──
  st.lastSignalMs  = now;
  st.lastDirection = signal;
  st.lockUntilMs   = now + cfg.directionLockMs;

  const prob = signal === 'BUY' ? mlLong : mlShort;

  return {
    action:            signal,               // 'BUY' | 'SELL'
    symbol,
    regime:            regimeInfo.regime,
    session,
    probability:       prob,
    threshold:         mlThreshold,
    atr:               fv.atr,
    close:             fv.close,
    slDistance:        fv.atr * 1.0,         // 1.0 ATR stop
    tpDistance:        fv.atr * 2.0,         // 2.0 ATR target (1:2 R:R minimum)
    breakevenDistance: fv.atr * 0.8,
    trailingDistance:  fv.atr * 1.2,
    exitMode:          'ATR',
    gate:              'gate2',
    pattern:           patName,
    agreeingCount:     agreeing,
    patterns:          patternResult.patterns,
    patternDetails:    patternResult.details,
    featureSnapshot:   features,
    timestamp:         fv.ts || Date.now()
  };
}

// ── Shadow mode: run gate2 in background, log result ─────────────────────────
// Called by server.js when shadowGate2=true. Fire-and-forget — never blocks NT8.
function decide2Shadow(symbol, candles, gate1Decision) {
  decide2(symbol, candles).then(gate2Decision => {
    _writeShadowLog({
      ts:           new Date().toISOString(),
      symbol,
      gate1Signal:  gate1Decision ? gate1Decision.action  : 'FLAT',
      gate1Reason:  gate1Decision ? gate1Decision.reason  : null,
      gate1Regime:  gate1Decision ? gate1Decision.regime  : null,
      gate2Signal:  gate2Decision.action,
      gate2Reason:  gate2Decision.reason || null,
      gate2Pattern: gate2Decision.pattern || null,
      gate2Agreeing:gate2Decision.agreeingCount || 0,
      gate2Patterns:gate2Decision.patterns || {},
      regime:       gate2Decision.regime || null,
      session:      gate2Decision.session || null,
      close:        (candles && candles.length > 0) ? candles[candles.length - 1].close : null,
      mlLongProb:   gate2Decision.probability || null,
      agrees:       gate1Decision && gate2Decision.action !== 'FLAT'
                    ? gate1Decision.action === gate2Decision.action
                    : null
    });
  }).catch(err => {
    // Never crash server.js — shadow errors are non-fatal
    console.warn(`[Gate2Shadow] ${symbol}: ${err.message}`);
  });
}

module.exports = {
  decide2,
  decide2Shadow,
  recordGate2TradeResult
};
