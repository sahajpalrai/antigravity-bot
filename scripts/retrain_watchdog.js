// Antigravity v2 — Retrain Watchdog
// ---------------------------------------------------------------------------
// Durable safety net for the nightly retrain. Scheduled ~45 min after the
// 9 PM full retrain. It:
//   1. Verifies a FULL retrain log was produced TODAY and reached completion.
//   2. Self-heals: if missing/incomplete/errored, re-runs the retrain ONCE.
//   3. Telegrams a clear verdict — and on hard failure, the exact error text
//      so a code bug (like the path/encoding ones) is caught and named fast.
//
// Deterministic, no LLM. Auto-rollback in the trainer means a re-run can't
// poison live bundles. Runs at most one self-heal re-run per firing.
//
// Usage:  node scripts/retrain_watchdog.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const LOGDIR = path.join(ROOT, 'models', 'retrain_logs');
const PS1    = path.join(ROOT, 'scripts', 'retrain_parallel.ps1');
const FRESH_HOURS = 8;   // a retrain log counts as "today's" if < 8h old

let _tg = () => {};
try { _tg = require(path.join(ROOT, 'lib', 'telegram')).sendTelegramMessage; } catch (e) {}
function tg(msg) { try { _tg(msg, { kind: 'system', header: '🩺 *Antigravity — Retrain Watchdog*' }); } catch (e) {} }
function log(m) {
  const line = `[Watchdog ${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(path.join(ROOT, 'logs', 'retrain_watchdog.log'), line + '\n'); } catch (e) {}
}

// Inspect the newest FULL-retrain summary/log: did it run today + finish + no hard error?
function checkRetrain() {
  let files;
  try { files = fs.readdirSync(LOGDIR); } catch (e) { return { ok: false, reason: 'no retrain_logs dir' }; }
  const now = Date.now();
  const isFresh = f => {
    try { return (now - fs.statSync(path.join(LOGDIR, f)).mtimeMs) < FRESH_HOURS * 3600 * 1000; }
    catch (e) { return false; }
  };

  // 1) A full-retrain summary from today?
  const summaries = files.filter(f => /^par_full_\d+_\d+_summary\.log$/.test(f) && isFresh(f))
    .map(f => ({ f, t: fs.statSync(path.join(LOGDIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  if (!summaries.length) return { ok: false, reason: 'no FULL retrain ran in the last ' + FRESH_HOURS + 'h' };

  const sumTxt = fs.readFileSync(path.join(LOGDIR, summaries[0].f), 'utf-8');
  // 2) Did it reach the completion marker?
  if (!/Results \(elapsed/.test(sumTxt)) return { ok: false, reason: 'retrain started but never finished (no Results line)', detail: summaries[0].f };

  // 3) Parse deploy counts
  const dep = (sumTxt.match(/deployed=\s*(\d+)/) || [])[1];
  const rej = (sumTxt.match(/rejected=\s*(\d+)/) || [])[1];

  // 4) Check the matching .err for HARD errors (ignore sklearn warnings)
  const lgbmErr = files.filter(f => /^lgbm_full_\d+_\d+\.err$/.test(f) && isFresh(f))
    .map(f => ({ f, t: fs.statSync(path.join(LOGDIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  if (lgbmErr) {
    const errTxt = fs.readFileSync(path.join(LOGDIR, lgbmErr.f), 'utf-8');
    const hard = errTxt.split('\n').filter(l => /Traceback|^\s*\w*Error:|ModuleNotFound|SyntaxError/.test(l) && !/Warning/i.test(l));
    if (hard.length) return { ok: false, reason: 'retrain hit a hard error', detail: hard.slice(-3).join(' | ') };
  }
  return { ok: true, deployed: dep, rejected: rej, file: summaries[0].f };
}

function rerun() {
  log('Self-heal: re-running FULL retrain...');
  execSync(`powershell.exe -NonInteractive -ExecutionPolicy Bypass -File "${PS1}"`,
    { cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15 * 60 * 1000 });
}

function main() {
  log('=== watchdog start ===');
  let r = checkRetrain();
  if (r.ok) {
    log(`healthy — deployed=${r.deployed} rejected=${r.rejected} (${r.file})`);
    tg(`✅ Nightly retrain OK — deployed ${r.deployed}, rejected ${r.rejected}.`);
    return;
  }

  log('UNHEALTHY: ' + r.reason + (r.detail ? ' | ' + r.detail : ''));
  tg(`⚠️ Retrain problem detected: ${r.reason}. Self-healing (re-running)…`);
  try {
    rerun();
  } catch (e) {
    log('re-run threw: ' + (e.message || e));
  }

  const r2 = checkRetrain();
  if (r2.ok) {
    log(`self-heal SUCCESS — deployed=${r2.deployed} rejected=${r2.rejected}`);
    tg(`🟢 Self-heal worked — retrain re-ran OK (deployed ${r2.deployed}, rejected ${r2.rejected}).`);
  } else {
    log('self-heal FAILED: ' + r2.reason + (r2.detail ? ' | ' + r2.detail : ''));
    tg(`❌ Retrain STILL failing after re-run: ${r2.reason}\n${r2.detail || ''}\nNeeds a code fix — check models/retrain_logs.`);
  }
  log('=== watchdog done ===');
}

main();
