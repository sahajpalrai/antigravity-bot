// Antigravity v2 — morning trading resume
// Re-enables NQ + ES (the symbols paused overnight) so the bot trades the RTH
// session. Scheduled 6:00 AM PT (30 min before the 6:30 AM RTH open).
// Safe: only flips the enable flag; if the server/NT8 link is down it just logs.
'use strict';
const http = require('http');
const SYMS = ['NQ=F', 'ES=F'];

function enable(sym) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ symbol: sym, enabled: true });
    const req = http.request({
      hostname: 'localhost', port: 3000, path: '/api/toggle-symbol', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 8000
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', e => resolve('ERROR ' + e.message));
    req.on('timeout', () => { req.destroy(); resolve('TIMEOUT'); });
    req.write(body); req.end();
  });
}

(async () => {
  const ts = new Date().toISOString();
  for (const s of SYMS) {
    const r = await enable(s);
    console.log(`[ResumeTrading ${ts}] enable ${s} -> ${r}`);
  }
})();
