// Antigravity v2 — Telegram alert client
//
// Reads credentials from models/credentials.json (gitignored). Falls back to
// env vars TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, then to baked-in defaults
// imported from V6 on 2026-05-26 (kept for backwards compat — safe to remove
// once credentials.json is the canonical source on every machine).
//
// Toggles (in credentials.json -> telegram):
//   enabled                  master on/off
//   new_trade_alert_enabled  fire on paper open
//   trade_alerts_pnl         fire on paper close (with P&L)
//   regime_alert_enabled     fire on session/regime transitions
//   circuit_breaker_enabled  fire when a symbol auto-disables
//   summary_enabled          periodic recap
//   summary_interval_min     recap cadence

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const CREDS_FILE = path.join(__dirname, '..', 'models', 'credentials.json');

let _cachedCreds = null;
let _cachedMtime = 0;

function _loadCreds() {
  try {
    if (!fs.existsSync(CREDS_FILE)) return null;
    const stat = fs.statSync(CREDS_FILE);
    if (_cachedCreds && stat.mtimeMs === _cachedMtime) return _cachedCreds;
    const obj = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8'));
    _cachedCreds = obj;
    _cachedMtime = stat.mtimeMs;
    return obj;
  } catch (e) {
    console.error('[Telegram] Failed to read credentials.json:', e.message);
    return null;
  }
}

function getTelegramConfig() {
  const creds = _loadCreds();
  const tg = (creds && creds.telegram) || {};
  return {
    token:    process.env.TELEGRAM_BOT_TOKEN || tg.bot_token || '8707962240:AAFGubG_ZMoe51E658oVJdCa4n9Ns0-7SZ0',
    chatId:   process.env.TELEGRAM_CHAT_ID  || tg.chat_id   || '1992829715',
    enabled:                  tg.enabled !== false,   // default ON
    newTradeAlertEnabled:     tg.new_trade_alert_enabled !== false,
    tradeAlertsPnl:           tg.trade_alerts_pnl !== false,
    regimeAlertEnabled:    !!tg.regime_alert_enabled,
    circuitBreakerEnabled: !!tg.circuit_breaker_enabled,
    summaryEnabled:        !!tg.summary_enabled,
    summaryIntervalMin:       tg.summary_interval_min || 60
  };
}

// Internal: fire an HTTPS request and retry once on transient network error
// (e.g. ECONNRESET from Telegram's API). Second failure is logged and dropped —
// alerts are best-effort, not critical path.
function _sendWithRetry(payload, options, attempt) {
  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (!parsed.ok) {
          console.error('[Telegram] Error response:', parsed.description);
        }
      } catch (e) {
        console.error('[Telegram] Failed to parse response:', e.message);
      }
    });
  });

  req.on('error', (err) => {
    if (attempt === 0) {
      console.warn(`[Telegram] Request error (${err.message}) — retrying in 3s`);
      setTimeout(() => _sendWithRetry(payload, options, 1), 3000);
    } else {
      console.error('[Telegram] Request error (retry failed):', err.message);
    }
  });

  req.write(payload);
  req.end();
}

// Send a Telegram notification using standard Node.js built-in 'https'.
// Pass `opts.kind = 'open' | 'close' | 'regime' | 'circuit' | 'summary' | 'system'`
// to gate by the per-event flags in credentials.json. Unspecified = always send.
function sendTelegramMessage(text, opts = {}) {
  const cfg = getTelegramConfig();
  if (!cfg.enabled) return;

  // Gate by event kind
  const kind = opts.kind;
  if (kind === 'open'    && !cfg.newTradeAlertEnabled)  return;
  if (kind === 'close'   && !cfg.tradeAlertsPnl)        return;
  if (kind === 'regime'  && !cfg.regimeAlertEnabled)    return;
  if (kind === 'circuit' && !cfg.circuitBreakerEnabled) return;
  if (kind === 'summary' && !cfg.summaryEnabled)        return;

  if (!cfg.token || !cfg.chatId) {
    console.log('[Telegram] Missing token or chat ID, skipping alert.');
    return;
  }

  const header = opts.header || '🛰️ *Antigravity v2*';
  // Telegram Markdown treats `_` as italic delimiter — bundle names like
  // ES_RTH_CHOP_long break parsing. Escape any underscore that isn't already
  // backslashed. (Caller can still use *...* for bold and [text](url) for
  // links; underscores get escaped to literal characters.)
  const safe = String(text).replace(/(^|[^\\])_/g, '$1\\_');
  const formattedText = `${header}\n\n${safe}`;

  const payload = JSON.stringify({
    chat_id: cfg.chatId,
    text: formattedText,
    parse_mode: 'Markdown'
  });

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${cfg.token}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  _sendWithRetry(payload, options, 0);
}

module.exports = {
  sendTelegramMessage,
  getTelegramConfig
};
