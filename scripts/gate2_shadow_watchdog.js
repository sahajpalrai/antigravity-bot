#!/usr/bin/env node
/* ============================================================================
 * Antigravity v2 — Gate 2 SHADOW WATCHDOG
 *
 * Gate 2 runs in shadow inside the main server (shadowGate2=true): on every bar
 * it logs what it WOULD have traded to gate2/shadow_log.json, firing nothing.
 * That log is capped at 2000 entries (~8h) and only tracks agreement with Gate 1
 * — it has NO P&L, so we can't tell if Gate 2 is actually profitable in shadow.
 *
 * This watchdog (run every ~30 min by a Scheduled Task) does 3 jobs, READ-ONLY
 * w.r.t. the live engine (it never touches Gate 1 or fires a trade):
 *
 *   1) HEALTH   — if the newest shadow bar is stale during market hours, the
 *                 shadow (or the whole server) has stopped. Telegram alert.
 *   2) HARVEST  — reconstruct Gate 2's would-be trades from the signal stream
 *                 (open on FLAT->BUY/SELL, close on flip/FLAT, mark-to-market at
 *                 the bar close) and APPEND new ones to a PERSISTENT ledger
 *                 (gate2/shadow_trades.json) so weeks of data accumulate even
 *                 though the raw log rolls every 8h.
 *   3) SCORE    — compute rolling PF / win-rate / net from the ledger and check
 *                 the GO-LIVE bar (PF >= 1.3 sustained + positive net over weeks).
 *                 Writes gate2/shadow_scorecard.json and Telegrams when Gate 2
 *                 first qualifies for a 1-contract live test.
 *
 * Nothing here enables live trading — it only tells us WHEN it would be safe to.
 * ========================================================================== */
'use strict';
const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const { spawn } = require('child_process');

const ROOT       = path.join(__dirname, '..');
const LOG_FILE   = path.join(ROOT, 'gate2', 'shadow_log.json');
const LEDGER     = path.join(ROOT, 'gate2', 'shadow_trades.json');
const SCORECARD  = path.join(ROOT, 'gate2', 'shadow_scorecard.json');
const STATE_FILE = path.join(ROOT, 'gate2', 'shadow_watchdog_state.json');

// Telegram (optional — degrades gracefully if creds missing)
let _tg = () => {};
try { _tg = require(path.join(ROOT, 'lib', 'telegram')).sendTelegramMessage; } catch (e) {}

// Gate 2's pattern engine is a stdlib-only Python HTTP service on port 3100.
// decide2 calls it per bar; if it's down, shadow logs dead FLATs. Keep it alive.
const ENGINE_PORT = 3100;
const PY = fs.existsSync('C:\\Python314\\python.exe') ? 'C:\\Python314\\python.exe' : 'python';
const ENGINE_ALERT_THROTTLE_MIN = 30;

function probeEngine() {
  return new Promise(resolve => {
    const req = http.get({ host: 'localhost', port: ENGINE_PORT, path: '/', timeout: 2500 }, res => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureEngineUp(state, now) {
  if (await probeEngine()) return { up: true, restarted: false };
  // Down -> relaunch detached with the pinned interpreter (stdlib only, no deps).
  let restarted = false;
  try {
    const out = fs.openSync(path.join(ROOT, 'logs', 'pattern_engine.log'), 'a');
    const err = fs.openSync(path.join(ROOT, 'logs', 'pattern_engine.err'), 'a');
    const child = spawn(PY, ['gate2/scripts/pattern_engine.py'], { cwd: ROOT, detached: true, stdio: ['ignore', out, err] });
    child.unref();
    restarted = true;
  } catch (e) { console.error('[gate2-watchdog] engine spawn failed:', e.message); }
  const since = (now - (state.lastEngineAlertMs || 0)) / 60000;
  if (since > ENGINE_ALERT_THROTTLE_MIN) {
    _tg(`♻️ Gate 2 pattern engine (port ${ENGINE_PORT}) was DOWN — watchdog restarted it. Shadow signals resume; nothing live is affected.`);
    state.lastEngineAlertMs = +now;
  }
  return { up: false, restarted };
}

// 1-contract point values (mini family). Commission = round-trip.
const POINT_VAL = { 'NQ=F': 20, 'ES=F': 50, 'CL=F': 1000, 'GC=F': 100 };
const COMM_RT   = 4.00;

// GO-LIVE bar — the criteria the owner endorsed: PF >= 1.3 SUSTAINED (not a 30-day
// fluke) + positive net, over a meaningful sample and span. Tunable here.
const GOLIVE = { minPF: 1.30, minNet: 0, minTrades: 150, minSpanDays: 15 };

// Freshness: alert if newest shadow bar older than this during market hours.
const STALE_MIN          = 20;
const FRESH_ALERT_THROTTLE_MIN = 60;
const LEDGER_CAP         = 20000;

function readJson(f, fallback) {
  try { const r = fs.readFileSync(f, 'utf8').trim(); return r ? JSON.parse(r) : fallback; }
  catch (e) { return fallback; }
}
function writeJson(f, obj) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, f);
}

// ── Is the futures market open right now? (ET-based) ──────────────────────────
// CME equities/metals/energy: Sun 18:00 ET -> Fri 17:00 ET, daily maintenance 17-18 ET.
function marketOpenET(now) {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();            // 0 Sun .. 6 Sat
  const h = et.getHours();
  if (day === 6) return false;                       // Sat closed
  if (day === 0) return h >= 18;                     // Sun opens 18:00 ET
  if (day === 5) return h < 17;                      // Fri closes 17:00 ET
  if (h === 17) return false;                        // daily maintenance 17-18 ET
  return true;
}

// ── Reconstruct would-be trades from the signal stream ────────────────────────
// Signal-following: enter when flat & signal != FLAT; exit when signal flips or
// goes FLAT, marked to market at that bar's close. An honest direction-quality
// proxy for Gate 2's live P&L (not identical to ATM exits, but consistent).
function reconstructTrades(rows) {
  const bySym = {};
  for (const r of rows) {
    if (!r || !r.symbol || typeof r.close !== 'number') continue;
    (bySym[r.symbol] = bySym[r.symbol] || []).push(r);
  }
  const trades = [];
  for (const sym of Object.keys(bySym)) {
    const pv = POINT_VAL[sym]; if (!pv) continue;
    const seq = bySym[sym].slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
    let pos = null;
    for (const r of seq) {
      const sig = (r.gate2Signal || 'FLAT').toUpperCase();
      const dir = sig === 'BUY' ? 1 : (sig === 'SELL' ? -1 : 0);
      if (!pos) {
        if (dir !== 0) pos = { dir, entryPrice: r.close, entryTs: r.ts, pattern: r.gate2Pattern || null, regime: r.regime || null, session: r.session || null };
      } else {
        const flip = (dir !== 0 && dir !== pos.dir);
        const flat = (dir === 0);
        if (flip || flat) {
          const pnl = (r.close - pos.entryPrice) * pos.dir * pv - COMM_RT;
          trades.push({ symbol: sym, dir: pos.dir === 1 ? 'LONG' : 'SHORT', entryTs: pos.entryTs, entryPrice: pos.entryPrice,
                        exitTs: r.ts, exitPrice: r.close, pnl: +pnl.toFixed(2), pattern: pos.pattern, regime: pos.regime, session: pos.session });
          pos = flip ? { dir, entryPrice: r.close, entryTs: r.ts, pattern: r.gate2Pattern || null, regime: r.regime || null, session: r.session || null } : null;
        }
      }
    }
  }
  return trades;
}

function stats(trades) {
  let w = 0, l = 0, gp = 0, gl = 0, net = 0;
  for (const t of trades) { net += t.pnl; if (t.pnl > 0) { w++; gp += t.pnl; } else if (t.pnl < 0) { l++; gl += Math.abs(t.pnl); } }
  return {
    trades: trades.length, wins: w, losses: l,
    winRate: (w + l) ? +(100 * w / (w + l)).toFixed(1) : null,
    profitFactor: gl > 0 ? +(gp / gl).toFixed(2) : (gp > 0 ? Infinity : null),
    net: +net.toFixed(2)
  };
}

async function main() {
  const now = new Date();
  const state = readJson(STATE_FILE, { lastFreshAlertMs: 0, goLiveAlerted: false, lastEngineAlertMs: 0 });

  // ── 0) KEEP THE PATTERN ENGINE (port 3100) ALIVE ──────────────────────────────
  const engine = await ensureEngineUp(state, now);

  const rows = readJson(LOG_FILE, []);

  // ── 1) HEALTH ───────────────────────────────────────────────────────────────
  let freshness = { lastBarTs: null, ageMin: null, stale: false };
  if (rows.length) {
    const lastTs = rows[rows.length - 1].ts;
    const ageMin = (now - new Date(lastTs)) / 60000;
    freshness = { lastBarTs: lastTs, ageMin: +ageMin.toFixed(1), stale: ageMin > STALE_MIN };
    if (freshness.stale && marketOpenET(now)) {
      const since = (now - state.lastFreshAlertMs) / 60000;
      if (since > FRESH_ALERT_THROTTLE_MIN) {
        _tg(`⚠️ Gate 2 SHADOW not logging — last shadow bar ${freshness.ageMin} min ago during market hours. The main server or the shadow engine may be down. Check Antigravity v2.`);
        state.lastFreshAlertMs = +now;
      }
    }
  }

  // ── 2) HARVEST (append new would-be trades to the persistent ledger) ──────────
  const ledger = readJson(LEDGER, []);
  const seen = new Set(ledger.map(t => t.symbol + '|' + t.entryTs));
  let added = 0;
  for (const t of reconstructTrades(rows)) {
    const k = t.symbol + '|' + t.entryTs;
    if (!seen.has(k)) { ledger.push(t); seen.add(k); added++; }
  }
  ledger.sort((a, b) => new Date(a.exitTs) - new Date(b.exitTs));
  if (ledger.length > LEDGER_CAP) ledger.splice(0, ledger.length - LEDGER_CAP);
  writeJson(LEDGER, ledger);

  // ── 3) SCORE + GO-LIVE bar ────────────────────────────────────────────────────
  const weekAgo = +now - 7 * 86400000;
  const recent  = ledger.filter(t => new Date(t.exitTs) >= weekAgo);
  const all = stats(ledger), last7 = stats(recent);
  const perSymbol = {};
  for (const sym of Object.keys(POINT_VAL)) perSymbol[sym] = stats(ledger.filter(t => t.symbol === sym));

  let spanDays = 0;
  if (ledger.length) spanDays = +((new Date(ledger[ledger.length - 1].exitTs) - new Date(ledger[0].exitTs)) / 86400000).toFixed(1);

  const ready = (all.profitFactor != null && all.profitFactor >= GOLIVE.minPF) &&
                (all.net > GOLIVE.minNet) && (all.trades >= GOLIVE.minTrades) && (spanDays >= GOLIVE.minSpanDays);
  const gates = {
    'PF>=1.30':       all.profitFactor != null && all.profitFactor >= GOLIVE.minPF,
    'net>0':          all.net > GOLIVE.minNet,
    [`trades>=${GOLIVE.minTrades}`]: all.trades >= GOLIVE.minTrades,
    [`span>=${GOLIVE.minSpanDays}d`]: spanDays >= GOLIVE.minSpanDays
  };

  const scorecard = {
    updatedAt: now.toISOString(),
    engine: { port: ENGINE_PORT, up: engine.up, restartedThisRun: engine.restarted },
    freshness, harvestedThisRun: added, ledgerSize: ledger.length, spanDays,
    all, last7, perSymbol,
    goLive: { ready, criteria: GOLIVE, gatesMet: gates,
              verdict: ready ? 'QUALIFIED — consider a 1-contract live test'
                             : 'NOT YET — keep gathering shadow data' }
  };
  writeJson(SCORECARD, scorecard);

  if (ready && !state.goLiveAlerted) {
    _tg(`✅ Gate 2 SHADOW QUALIFIED for a live test.\nPF ${all.profitFactor} · net $${all.net} · WR ${all.winRate}% · ${all.trades} trades over ${spanDays}d.\nNext step: a TINY 1-contract live test — your call.`);
    state.goLiveAlerted = true;
  } else if (!ready && state.goLiveAlerted) {
    state.goLiveAlerted = false;  // dropped back below the bar — re-arm the alert
  }
  writeJson(STATE_FILE, state);

  // Console summary (captured to the watchdog log by the .bat)
  console.log(`[gate2-shadow-watchdog] ${now.toISOString()}`);
  console.log(`  engine: port ${ENGINE_PORT} ${engine.up ? 'UP' : (engine.restarted ? 'was DOWN -> restarted' : 'DOWN')}`);
  console.log(`  health: lastBar ${freshness.ageMin}min ago, stale=${freshness.stale}, market=${marketOpenET(now) ? 'OPEN' : 'closed'}`);
  console.log(`  harvest: +${added} trades  (ledger ${ledger.length}, span ${spanDays}d)`);
  console.log(`  score ALL: PF=${all.profitFactor} net=$${all.net} WR=${all.winRate}% n=${all.trades}`);
  console.log(`  score 7d : PF=${last7.profitFactor} net=$${last7.net} WR=${last7.winRate}% n=${last7.trades}`);
  console.log(`  GO-LIVE: ${ready ? 'QUALIFIED' : 'not yet'}  ${JSON.stringify(gates)}`);
}

main().catch(e => { console.error('[gate2-shadow-watchdog] FATAL', e); process.exit(1); });
