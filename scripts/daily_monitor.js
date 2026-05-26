// Antigravity v2 — Daily health monitor
// Runs once per day (typically at 5 PM PT after the session). Posts a concise
// summary covering:
//   • Paper trade results (last 24h + cumulative)
//   • Per-symbol P&L
//   • Bundles currently deployed (drift watch — flag if count drops 25%+)
//   • Buckets flagged for retrain
//   • Loss-streak warnings (any bucket with 3+ consecutive losses)
//   • Quality floor status (RTH 60% / ETH 55% reminder)
// Output is appended to models/daily_monitor_history.json AND written to a
// dated log file in models/monitor_logs/.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '..', 'models', 'daily_monitor_history.json');
const ALERTS_FILE  = path.join(__dirname, '..', 'models', 'active_alerts.json');
const LOGS_DIR     = path.join(__dirname, '..', 'models', 'monitor_logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// Detect issues that need attention. Returns array of alerts (each with
// severity / category / message / data). Alerts are persisted to
// active_alerts.json so the Claude monitor wakeup chain can react.
function _detectAlerts(state, models, paper, events) {
  const alerts = [];
  const now = new Date().toISOString();

  if (!state) {
    alerts.push({ ts: now, severity: 'critical', category: 'server', message: 'Server unreachable on localhost:3000' });
    return alerts;
  }

  // Bundle drift — sudden drop in deployed count
  const dep = (models?.models || []).filter(m => m.enabled).length;
  if (dep < 8) {
    alerts.push({ ts: now, severity: 'warning', category: 'bundles',
      message: `Only ${dep} bundles deployed (expected ≥ 8 with hybrid 60/55)`,
      data: { deployedCount: dep }
    });
  }

  // Per-symbol coverage — every family should have ≥ 1 deployed bundle
  for (const sym of ['NQ=F', 'ES=F', 'CL=F', 'GC=F']) {
    const symDep = (models?.models || []).filter(m => m.enabled && m.symbol === sym).length;
    if (symDep === 0) {
      alerts.push({ ts: now, severity: 'warning', category: 'symbol_coverage',
        message: `${sym} has 0 deployed bundles — bot can't trade this family`,
        data: { symbol: sym }
      });
    }
  }

  // Recent warnings on event bus
  const warnings = (events?.events || []).filter(e => e.type === 'WARNING');
  if (warnings.length > 0) {
    alerts.push({ ts: now, severity: 'warning', category: 'loss_streak',
      message: `${warnings.length} bucket(s) on loss streak`,
      data: { warnings: warnings.slice(-5).map(w => w.message) }
    });
  }

  // Recent errors
  const errors = (events?.events || []).filter(e => e.type === 'ERROR');
  if (errors.length > 0) {
    alerts.push({ ts: now, severity: 'critical', category: 'errors',
      message: `${errors.length} error(s) in event stream`,
      data: { errors: errors.slice(-5).map(e => e.message) }
    });
  }

  // Paper performance check — if 50+ trades AND WR < 50%, alert
  if (paper?.stats && paper.stats.total >= 50 && paper.stats.winRate < 0.50) {
    alerts.push({ ts: now, severity: 'critical', category: 'underperformance',
      message: `Paper WR dropped to ${(paper.stats.winRate * 100).toFixed(1)}% over ${paper.stats.total} trades (below 50%)`,
      data: { winRate: paper.stats.winRate, total: paper.stats.total }
    });
  }

  // Last-24h loss check
  if (Array.isArray(paper?.recent)) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = paper.recent.filter(t => new Date(t.exitTime).getTime() >= cutoff);
    if (recent.length >= 10) {
      const pnl24 = recent.reduce((s, t) => s + t.pnl, 0);
      const wins24 = recent.filter(t => t.pnl > 0).length;
      const wr24 = wins24 / recent.length;
      if (wr24 < 0.40 || pnl24 < -500) {
        alerts.push({ ts: now, severity: 'warning', category: 'recent_losses',
          message: `Last 24h: ${recent.length} trades, WR ${(wr24 * 100).toFixed(0)}%, P&L $${pnl24.toFixed(2)}`,
          data: { winRate: wr24, count: recent.length, pnl: pnl24 }
        });
      }
    }
  }

  return alerts;
}

function get(p) {
  return new Promise((resolve) => {
    http.get(`http://localhost:3000${p}`, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function main() {
  const now = new Date();
  const ts  = now.toISOString();
  const lines = [];
  const w = (s) => { lines.push(s); console.log(s); };

  w('═══════════════════════════════════════════════════════════════════');
  w(`  ANTIGRAVITY v2 — DAILY MONITOR REPORT`);
  w(`  Generated: ${ts}`);
  w('═══════════════════════════════════════════════════════════════════');

  // 1. Server reachable?
  const state = await get('/api/state');
  if (!state) {
    w('  ✗ Server unreachable on localhost:3000 — bot is DOWN.');
    _writeAndExit(now, lines, { error: 'server_down' });
    return;
  }
  w(`  ✓ Server up · ${state.tradingMode} mode · ${state.contractMode} contracts`);
  w(`  ✓ Total equity: $${(state.totalEquity || 0).toFixed(2)}`);
  w(`  ✓ Open P&L: ${state.totalOpenPnL >= 0 ? '+' : ''}$${(state.totalOpenPnL || 0).toFixed(2)}`);

  // 2. Quality floors
  const floors = state.qualityFloors || {};
  w('');
  w('─── QUALITY FLOORS ───');
  w(`  RTH: ${((floors.rth || 0) * 100).toFixed(0)}% · ETH: ${((floors.eth || 0) * 100).toFixed(0)}%`);

  // 3. Bundles deployed
  const models = await get('/api/models');
  const dep    = (models?.models || []).filter(m => m.enabled);
  const total  = (models?.models || []).length;
  w('');
  w('─── BUNDLES DEPLOYED ───');
  w(`  ${dep.length} / ${total}`);
  for (const sym of ['NQ=F','ES=F','CL=F','GC=F']) {
    const sd = dep.filter(d => d.symbol === sym);
    const rth = sd.filter(d => d.session === 'RTH').length;
    const eth = sd.filter(d => d.session === 'ETH').length;
    w(`    ${sym}  RTH=${rth} · ETH=${eth} · total=${sd.length}`);
  }

  // 4. Paper trade stats — cumulative + last 24h
  const paper = await get('/api/paper');
  w('');
  w('─── PAPER TRADING ───');
  if (paper?.stats) {
    const s = paper.stats;
    w(`  Total trades:    ${s.total}`);
    w(`  Win rate:        ${s.total > 0 ? (s.winRate * 100).toFixed(1) + '%' : '—'}`);
    w(`  Net R:           ${(s.netR || 0).toFixed(2)}`);
    w(`  Open positions:  ${s.openPositions || 0}`);
  }
  // Last 24h slice
  if (Array.isArray(paper?.recent)) {
    const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
    const recent = paper.recent.filter(t => new Date(t.exitTime).getTime() >= cutoff);
    if (recent.length > 0) {
      const wins24 = recent.filter(t => t.pnl > 0).length;
      const pnl24  = recent.reduce((s, t) => s + t.pnl, 0);
      w(`  Last 24h:        ${recent.length} trades · WR ${(wins24 / recent.length * 100).toFixed(0)}% · P&L $${pnl24.toFixed(2)}`);
    } else {
      w(`  Last 24h:        (no closed trades)`);
    }
  }

  // 5. Loss-streak warnings (from event bus)
  const events = await get('/api/events');
  const lossAudits = (events?.events || []).filter(e => e.type === 'LOSS_AUDIT');
  const warnings   = (events?.events || []).filter(e => e.type === 'WARNING');
  w('');
  w('─── DIAGNOSTICS (last 220 events in ring) ───');
  w(`  Loss audits:     ${lossAudits.length}`);
  w(`  Warnings:        ${warnings.length}`);
  if (warnings.length > 0) {
    w(`  ⚠ Most recent:`);
    for (const wEvt of warnings.slice(-5)) {
      w(`    ${wEvt.message}`);
    }
  }

  // 6. Retrain flags from loss auditor
  // Hit /api/run-audit which returns bucket stats + retrain flags
  const audit = await new Promise((resolve) => {
    const data = JSON.stringify({});
    const opts = { hostname: 'localhost', port: 3000, path: '/api/run-audit', method: 'POST',
                   headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } };
    const r = http.request(opts, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    r.on('error', () => resolve(null));
    r.write(data); r.end();
  });
  if (audit?.buckets) {
    const flagged = audit.buckets.filter(b => b.retrainFlag);
    w('');
    w('─── BUCKETS FLAGGED FOR RETRAIN ───');
    w(`  ${flagged.length} of ${audit.buckets.length} buckets`);
    for (const f of flagged.slice(0, 5)) {
      w(`    ${f.key}  WR=${(f.winRate * 100).toFixed(0)}%  trades=${f.trades}  flag=${f.reason}`);
    }
  }

  w('');
  w('═══════════════════════════════════════════════════════════════════');
  w('  END OF REPORT');
  w('═══════════════════════════════════════════════════════════════════');

  // Alerts — detect + persist
  const alerts = _detectAlerts(state, models, paper, events);
  w('');
  w('─── ALERTS ───');
  if (alerts.length === 0) {
    w('  ✓ No alerts — all systems nominal.');
  } else {
    for (const a of alerts) {
      w(`  ${a.severity === 'critical' ? '🔴' : '⚠'} [${a.category}] ${a.message}`);
    }
  }
  fs.writeFileSync(ALERTS_FILE, JSON.stringify({
    generatedAt: ts,
    alertCount: alerts.length,
    criticalCount: alerts.filter(a => a.severity === 'critical').length,
    alerts
  }, null, 2));

  _writeAndExit(now, lines, {
    timestamp: ts,
    equity: state.totalEquity,
    openPnl: state.totalOpenPnL,
    deployedCount: dep.length,
    paperTrades: paper?.stats?.total || 0,
    paperWR: paper?.stats?.winRate || 0,
    lossAudits: lossAudits.length,
    warnings: warnings.length,
    alertCount: alerts.length
  });
}

function _writeAndExit(now, lines, snapshot) {
  // Append to history — keep last 30 days at hourly cadence (= 720 entries)
  let hist = [];
  if (fs.existsSync(HISTORY_FILE)) {
    try { hist = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); } catch (e) {}
  }
  hist.push(snapshot);
  if (hist.length > 750) hist = hist.slice(-750);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist, null, 2));

  // Write this run's full text log
  const stamp = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const logFile = path.join(LOGS_DIR, `monitor_${stamp}.log`);
  fs.writeFileSync(logFile, lines.join('\n'), 'utf-8');

  // Prune old log files — keep last 720 (= 30 days at hourly cadence)
  try {
    const allLogs = fs.readdirSync(LOGS_DIR)
      .filter(f => f.startsWith('monitor_'))
      .sort();
    while (allLogs.length > 720) {
      const oldest = allLogs.shift();
      fs.unlinkSync(path.join(LOGS_DIR, oldest));
    }
  } catch (e) { /* ignore prune errors */ }

  console.log(`\nWritten: ${path.basename(logFile)}`);
}

main();
