'use strict';
// Antigravity v2 — Server Watchdog (the supervisor we never had).
// Runs every ~3 min via Task Scheduler. ONE job: keep the brain PROCESS alive.
//   • /api/state unreachable on :3000 (crashed / hung) -> restart the brain.
// That's it. We deliberately do NOT restart on a stale feed: if NT8 itself is
// closed, restarting the brain fixes nothing and just churns. The feed-zombie
// case (brain up, NT8 up, socket desynced) is already handled by the bridge's
// keepalive + idle reaper, and a drop fires a Telegram alert. So this watchdog
// stays narrow and safe: it only acts when the brain is genuinely down.
// 10-min restart cooldown prevents loops. Restart is fire-and-forget.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT         = path.join(__dirname, '..');
const LOGDIR       = path.join(ROOT, 'logs');
const LAST_RESTART = path.join(ROOT, 'models', '.watchdog_last_restart');
const RESTART_PS   = path.join(ROOT, 'scripts', 'restart_server.ps1');
const COOLDOWN_MS  = 10 * 60 * 1000;

function log(m) {
  const line = `[${new Date().toISOString()}] ${m}\n`;
  try { fs.appendFileSync(path.join(LOGDIR, 'server_watchdog.log'), line); } catch (e) {}
}
function tg(m) { try { require('../lib/telegram').sendTelegramMessage(m); } catch (e) {} }
function recentlyRestarted() {
  try { return (Date.now() - parseInt(fs.readFileSync(LAST_RESTART, 'utf8'), 10)) < COOLDOWN_MS; }
  catch (e) { return false; }
}
function markRestart() { try { fs.writeFileSync(LAST_RESTART, String(Date.now())); } catch (e) {} }

function doRestart(reason) {
  if (recentlyRestarted()) { log(`RESTART skipped (${reason}) — within ${COOLDOWN_MS / 60000}min cooldown`); return; }
  markRestart();
  log(`RESTARTING brain — reason: ${reason}`);
  // Fire-and-forget: detached so the watchdog doesn't block/time out on it.
  try {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RESTART_PS],
      { detached: true, stdio: 'ignore' });
    child.unref();
    tg(`🔄 Watchdog: brain was down (${reason}) — restarting it now.`);
  } catch (e) { log(`RESTART spawn error: ${e.message}`); }
}
function main() {
  const req = http.get({ host: 'localhost', port: 3000, path: '/api/state', timeout: 6000 }, res => {
    // Any HTTP response = brain process is alive. Drain + exit; nothing to do.
    res.on('data', () => {});
    res.on('end', () => log('OK — brain alive on :3000'));
  });
  req.on('error',   e => { log(`brain UNRESPONSIVE (${e.message})`); doRestart('server-down'); });
  req.on('timeout', () => { req.destroy(); log('brain TIMEOUT (>6s)'); doRestart('server-timeout'); });
}
main();
