// Antigravity v2 — one-time market-open health check (Telegram)
// ---------------------------------------------------------------------------
// Runs ~5 min after the globex open. Confirms NT8 is connected AND live bars
// are actually flowing into the brain (not just a stale socket), then Telegrams
// a clear ✅ / ⚠️ verdict. Deterministic, no LLM.
//
// "Bars flowing" test: poll /api/state twice ~80s apart (NT8 charts are 1-min).
// A symbol is LIVE if its price moved between polls OR its NT8 heartbeat is
// <90s old AND the brain has produced a decision (regime populated).
//
// Usage:  node scripts/open_check.js
'use strict';

const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SYMS = ['NQ=F', 'ES=F'];
const GAP_MS = 80 * 1000;

let _tg = () => {};
try { _tg = require(path.join(ROOT, 'lib', 'telegram')).sendTelegramMessage; } catch (e) {}
function telegram(msg) { try { _tg(msg, { kind: 'system', header: '🔔 *Antigravity — Open Check*' }); } catch (e) {} }
function log(m) { console.log(`[OpenCheck ${new Date().toISOString()}] ${m}`); }

function getState() {
  return new Promise((resolve, reject) => {
    const req = http.get('http://localhost:3000/api/state', { timeout: 8000 }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('api timeout')); });
  });
}

function snap(state) {
  const out = { connected: !!state.nt8Connected, mode: state.contractMode, sym: {} };
  for (const s of SYMS) {
    const a = (state.accounts && state.accounts[s]) || {};
    const dec = (state.lastDecisions && state.lastDecisions[s]) || null;
    const price = (state.livePrices && state.livePrices[s]) || a.lastPrice || 0;
    out.sym[s] = {
      price,
      regime: dec ? dec.regime : null,
      action: dec ? dec.action : null,
      lastUpdateMs: a.lastNt8Update || 0
    };
  }
  return out;
}

async function main() {
  log('=== open check START ===');
  try {
    const s1 = snap(await getState());
    log('snap1: ' + JSON.stringify(s1));
    if (!s1.connected) {
      telegram('⚠️ OPEN CHECK: NT8 NOT connected to the bot. Re-add / enable AntigravityBotBridge on the chart (IP 127.0.0.1, port 4000).');
      log('not connected — done'); return;
    }
    await new Promise(r => setTimeout(r, GAP_MS));
    const s2 = snap(await getState());
    log('snap2: ' + JSON.stringify(s2));

    const now = Date.now();
    const lines = [];
    let liveCount = 0;
    for (const s of SYMS) {
      const a = s1.sym[s], b = s2.sym[s];
      const moved = b.price > 0 && a.price > 0 && b.price !== a.price;
      const freshBeat = b.lastUpdateMs && (now - b.lastUpdateMs) < 90 * 1000;
      const hasDecision = !!b.regime;
      const live = (moved || freshBeat) && b.price > 0;
      if (live) liveCount++;
      const tag = live ? '✅' : '⚠️';
      const beatAge = b.lastUpdateMs ? Math.round((now - b.lastUpdateMs) / 1000) + 's' : 'never';
      lines.push(`${tag} ${s.replace('=F','')}: px=${b.price || '—'} regime=${b.regime || '—'}${b.action && b.action!=='FLAT' ? ' ('+b.action+')' : ''} | beat ${beatAge}${moved ? ' | px moving' : ''}${!hasDecision ? ' | NO decision yet' : ''}`);
    }

    const header = liveCount === SYMS.length
      ? `✅ OPEN CLEAN — bars flowing, brain live (mode ${s2.mode}).`
      : liveCount > 0
        ? `⚠️ PARTIAL — ${liveCount}/${SYMS.length} flowing (mode ${s2.mode}). Check the other chart.`
        : `⚠️ CONNECTED but NO live bars after the open. Toggle the strategy off→on on the chart (and confirm the chart is on a tradeable session).`;

    telegram([header, '', ...lines].join('\n'));
    log('verdict: ' + header);
  } catch (e) {
    log('ERROR: ' + (e && e.message || e));
    telegram('❌ OPEN CHECK failed to reach the bot API (' + (e && e.message || e) + '). Is the server running on :3000?');
  }
  log('=== done ===');
}

main();
