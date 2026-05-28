// Antigravity v2 — LLM Market Analyst (Track B)
//
// Sends a compact market snapshot to OpenAI (gpt-4o-mini) after each bar close.
// The result is cached so the synchronous decide() function can read it on the
// NEXT bar without blocking the event loop.
//
// Flow:
//   Bar T closes → server.js calls prefetch(symbol, ...) → async, non-blocking
//   Bar T+1 closes → server.js calls decide() → reads getLastSignal() from cache
//
// Design goals:
//   • No external npm deps (Node.js built-in https only)
//   • Graceful degradation: API error → FLAT signal, decide() falls through to GBDT
//   • Cost: ~200 tokens × 4 symbols × 12 bars/hr × 16hr ≈ $0.02/day (gpt-4o-mini)
//
// Credentials: models/credentials.json → openai_api_key (or env OPENAI_API_KEY)

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CREDS_FILE         = path.join(__dirname, '..', 'models', 'credentials.json');
const TIMEOUT_MS         = 9000;
const MODEL              = 'gpt-4o-mini';
const CONFIDENCE_FLOOR   = 0.60;   // below this → action becomes FLAT
const MAX_SIGNAL_AGE_MS  = 360000; // 6 min — discard stale signals (e.g. after server pause)

// ── Credentials ──────────────────────────────────────────────────────────────
function _getApiKey() {
  try {
    const c = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8'));
    return c.openai_api_key || c.openaiApiKey || c.openai_key ||
           (c.openai && (c.openai.api_key || c.openai.apiKey)) ||
           process.env.OPENAI_API_KEY || null;
  } catch (e) {
    return process.env.OPENAI_API_KEY || null;
  }
}

// ── Signal store — one entry per symbol ──────────────────────────────────────
// { fetchedAt: Date.now(), result: { action, confidence, reasoning, risk, source } }
const _store = new Map();
// Track in-flight calls to avoid duplicate concurrent requests per symbol
const _inflight = new Set();

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a professional futures day-trading analyst embedded in an automated system.
Analyze the 5-minute bar snapshot below and return a directional signal.

ALWAYS respond with ONLY a JSON object on ONE line — no markdown, no extra text.

Format: {"action":"LONG","confidence":0.72,"reasoning":"One sentence.","risk":"One sentence."}

Rules:
- action: "LONG", "SHORT", or "FLAT"
- confidence: 0.0 to 1.0
- If confidence < 0.60, set action to "FLAT"
- FLAT when: RSI > 75 for LONG setups; RSI < 25 for SHORT setups
- FLAT during deep overnight (PT hour 22-02: very low NQ/ES volume, high false-breakout rate)
- In TREND_UP regime: prefer LONG continuation; only SHORT if MACD histogram clearly negative
- In TREND_DOWN regime: prefer SHORT continuation; only LONG if MACD histogram clearly positive
- In CHOP regime: mean-reversion setups only (fade extremes)
- EMA stack: ema9_above_ema21=true AND ema21_above_ema50=true = bullish — do not short unless strong reversal signals
- When model long_prob >= threshold AND technicals confirm: LONG with high confidence
- When model short_prob >= threshold AND technicals confirm: SHORT with high confidence
- Be decisive — a clear setup gets 0.70-0.85 confidence; only use 0.90+ for exceptional clarity`;

// ── Build snapshot ────────────────────────────────────────────────────────────
function _buildSnapshot(symbol, session, barTs, fvMap, recentBars, gbdtSignal, regime) {
  const bars = (recentBars || []).slice(-8).map(c => ({
    t: String(c.time || '').slice(11, 16),
    o: +Number(c.open  || 0).toFixed(2),
    h: +Number(c.high  || 0).toFixed(2),
    l: +Number(c.low   || 0).toFixed(2),
    c: +Number(c.close || 0).toFixed(2),
    v: c.volume || 0
  }));

  const snap = {
    symbol,
    session,
    bar_time: String(barTs || '').slice(0, 16),
    regime: regime || 'UNKNOWN',
    price: +(fvMap.close || 0).toFixed(2),
    indicators: {
      rsi:              +(fvMap.rsi        || 50).toFixed(1),
      macd_hist:        +(fvMap.macd_hist  ||  0).toFixed(4),
      adx:              +(fvMap.adx        || 20).toFixed(1),
      bb_z:             +(fvMap.bb_z       ||  0).toFixed(2),
      atr_pct:          +(fvMap.atr_pct    ||  0).toFixed(5),
      ema9_above_ema21: (fvMap.ema9_21_gap  || 0) > 0,
      ema21_above_ema50:(fvMap.ema21_50_gap || 0) > 0,
      vol_z:            +(fvMap.vol_z      ||  0).toFixed(2),
      ret_1:            +(fvMap.ret_1      ||  0).toFixed(5),
      ret_5:            +(fvMap.ret_5      ||  0).toFixed(5)
    },
    model: gbdtSignal ? {
      long_prob:  +(gbdtSignal.longProb  || 0).toFixed(3),
      short_prob: +(gbdtSignal.shortProb || 0).toFixed(3),
      long_th:    +(gbdtSignal.longTh    || 0.65).toFixed(3),
      short_th:   +(gbdtSignal.shortTh   || 0.65).toFixed(3)
    } : null,
    recent_bars: bars
  };

  // VWAP deviation — Track C feature (available after featureEngineer upgrade)
  if (typeof fvMap.vwap_dev_atr === 'number') {
    snap.indicators.vwap_dev_atr = +(fvMap.vwap_dev_atr).toFixed(3);
  }

  return snap;
}

// ── OpenAI HTTP call (native https, no deps) ──────────────────────────────────
function _callOpenAI(apiKey, userContent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: JSON.stringify(userContent) }
      ],
      temperature: 0.2,
      max_tokens: 120,
      response_format: { type: 'json_object' }
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path:     '/v1/chat/completions',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || 'OpenAI error'));
          const text = parsed.choices?.[0]?.message?.content || '{}';
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error(`parse error: ${e.message} — raw: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Public: prefetch LLM signal (call after each bar close, non-blocking) ────
// Starts async LLM analysis for the symbol. Result stored in _store.
// The next call to decide() will read it synchronously via getLastSignal().
//
// args:
//   symbol      — 'NQ=F' | 'ES=F' | 'CL=F' | 'GC=F'
//   session     — 'RTH' | 'ETH'
//   barTs       — bar close timestamp (string)
//   fvMap       — { featureName: value } — from featureSnapshot built in decisionEngine
//   candles     — full candle array (last 8 used for recent_bars)
//   gbdtSignal  — { longProb, shortProb, longTh, shortTh } or null
//   regime      — regime string
function prefetch(symbol, session, barTs, fvMap, candles, gbdtSignal, regime) {
  if (_inflight.has(symbol)) return;  // already fetching for this symbol

  const apiKey = _getApiKey();
  if (!apiKey) {
    // No key — store FLAT immediately, no network call
    _store.set(symbol, {
      fetchedAt: Date.now(),
      result: { action: 'FLAT', confidence: 0, reasoning: 'OpenAI key not configured', risk: '', source: 'no_key' }
    });
    return;
  }

  _inflight.add(symbol);
  const snapshot = _buildSnapshot(symbol, session, barTs, fvMap, candles, gbdtSignal, regime);
  const t0 = Date.now();

  _callOpenAI(apiKey, snapshot)
    .then(raw => {
      const action = (['LONG', 'SHORT', 'FLAT'].includes(String(raw.action || '').toUpperCase()))
        ? raw.action.toUpperCase()
        : 'FLAT';
      const confidence = Math.max(0, Math.min(1, parseFloat(raw.confidence || 0)));
      const finalAction = (action !== 'FLAT' && confidence < CONFIDENCE_FLOOR) ? 'FLAT' : action;

      _store.set(symbol, {
        fetchedAt: Date.now(),
        result: {
          action:     finalAction,
          confidence,
          reasoning:  String(raw.reasoning || '').slice(0, 200),
          risk:       String(raw.risk      || '').slice(0, 200),
          source:     'llm',
          latencyMs:  Date.now() - t0,
          rawAction:  action   // pre-confidence-filter, useful for logging
        }
      });
      console.log(`[LLM] ${symbol} → ${finalAction} (conf=${confidence.toFixed(2)}) in ${Date.now()-t0}ms`);
    })
    .catch(err => {
      const isTimeout = err.message === 'timeout';
      _store.set(symbol, {
        fetchedAt: Date.now(),
        result: {
          action:    'FLAT',
          confidence: 0,
          reasoning: `LLM ${isTimeout ? 'timeout' : 'error'}: ${err.message}`,
          risk:      '',
          source:    isTimeout ? 'timeout' : 'error',
          latencyMs: Date.now() - t0
        }
      });
      if (!isTimeout) console.error(`[LLM] ${symbol} error: ${err.message}`);
    })
    .finally(() => {
      _inflight.delete(symbol);
    });
}

// ── Public: get the last cached signal (synchronous) ─────────────────────────
// Returns null if: never fetched, or signal older than MAX_SIGNAL_AGE_MS (6 min).
// decide() treats null as "LLM unavailable" → falls through to GBDT-only gate.
function getLastSignal(symbol) {
  const entry = _store.get(symbol);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > MAX_SIGNAL_AGE_MS) return null;
  return entry.result;
}

// ── Public: is an API key configured? ─────────────────────────────────────────
function isConfigured() {
  return !!_getApiKey();
}

// ── Public: status for dashboard ──────────────────────────────────────────────
function getStatus() {
  const status = {};
  for (const [sym, entry] of _store) {
    status[sym] = {
      action:    entry.result.action,
      confidence: entry.result.confidence,
      source:    entry.result.source,
      ageMs:     Date.now() - entry.fetchedAt,
      reasoning: entry.result.reasoning
    };
  }
  return { configured: isConfigured(), signals: status };
}

module.exports = { prefetch, getLastSignal, isConfigured, getStatus };
