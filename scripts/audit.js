// Antigravity v2 — Comprehensive backend audit
// Hits every API endpoint against a running server on localhost:3000 and
// reports pass/fail per check. Use to verify nothing regressed.

'use strict';
const http = require('http');

function req(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 3000, path, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    };
    const r = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(buf); } catch (e) { parsed = buf.slice(0, 120); }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log('═════════════════════════════════════════════════════════════════');
  console.log(' ANTIGRAVITY v2 — COMPREHENSIVE BACKEND AUDIT');
  console.log('═════════════════════════════════════════════════════════════════\n');

  const checks = [];
  function record(area, name, ok, detail) {
    checks.push({ area, name, ok, detail });
    console.log((ok ? '✓ ' : '✗ ') + '[' + area + '] ' + name + (detail ? '  ·  ' + detail : ''));
  }

  // STATE
  const state = (await req('GET', '/api/state')).body;
  record('STATE', '/api/state returns 8 accounts', Object.keys(state.accounts || {}).length === 8, 'got ' + Object.keys(state.accounts).length);
  record('STATE', 'contractMode present', !!state.contractMode, 'value=' + state.contractMode);
  record('STATE', 'miniSymbols array', Array.isArray(state.miniSymbols), (state.miniSymbols || []).join(','));
  record('STATE', 'microSymbols array', Array.isArray(state.microSymbols), (state.microSymbols || []).join(','));
  record('STATE', 'contractSpecs map', typeof state.contractSpecs === 'object', Object.keys(state.contractSpecs || {}).length + ' specs');
  record('STATE', 'tradingMode field', !!state.tradingMode, state.tradingMode);
  record('STATE', 'lastDecisions object', typeof state.lastDecisions === 'object');
  record('STATE', 'livePrices object', typeof state.livePrices === 'object');
  record('STATE', 'totalEquity computed', typeof state.totalEquity === 'number', '$' + state.totalEquity);

  // MODELS
  const models = (await req('GET', '/api/models')).body;
  const enabled = models.models.filter((m) => m.enabled).length;
  record('MODELS', 'returns array', Array.isArray(models.models), models.models.length + ' total');
  record('MODELS', 'quality gate active', enabled > 0 && enabled < models.models.length, enabled + ' deployed / ' + (models.models.length - enabled) + ' gated');
  record('MODELS', 'each has aggregate', models.models.every((m) => m.aggregate));
  record('MODELS', 'each has threshold', models.models.every((m) => typeof m.threshold === 'number'));
  record('MODELS', 'gateReason on disabled', models.models.filter((m) => !m.enabled).every((m) => m.gateReason));

  // CONTRACT MODE
  const t1 = await req('POST', '/api/contract-mode', { mode: 'MICRO' });
  record('TOGGLE', 'POST MICRO accepted', t1.status === 200 && t1.body.status === 'success', 'mode=' + t1.body.mode);
  const s2 = (await req('GET', '/api/state')).body;
  record('TOGGLE', 'state reflects toggle', s2.contractMode === 'MICRO');
  await req('POST', '/api/contract-mode', { mode: 'MINI' });
  const t2 = await req('POST', '/api/contract-mode', { mode: 'INVALID' });
  record('TOGGLE', 'invalid mode rejected', t2.status === 400);

  // EXITS — per-symbol schema (4 mini + 4 micro, each with RTH + ETH)
  const ex = (await req('GET', '/api/exits')).body;
  record('EXITS', '/api/exits returns per-symbol config', !!ex.config && !!ex.config['NQ=F'] && !!ex.config['NQ=F'].RTH && !!ex.config['NQ=F'].ETH);
  record('EXITS', 'all 8 symbols present', ['NQ=F','ES=F','CL=F','GC=F','MNQ=F','MES=F','MCL=F','MGC=F'].every((s) => !!ex.config[s]));
  record('EXITS', 'fixedActive defaults false', ex.fixedActive === false);
  const exSet = await req('POST', '/api/exits', { symbol: 'NQ=F', session: 'RTH', values: { enabled: true, profitPoints: 12, stopPoints: 6 } });
  record('EXITS', 'POST per-symbol persists', exSet.body.status === 'success' && exSet.body.config['NQ=F'].RTH.enabled === true);
  const exGet2 = (await req('GET', '/api/exits')).body;
  record('EXITS', 'fixedActive reflects toggle', exGet2.fixedActive === true);
  await req('POST', '/api/exits', { symbol: 'NQ=F', session: 'RTH', values: { enabled: false } });

  // EVENTS
  const ev = (await req('GET', '/api/events')).body;
  record('EVENTS', 'returns events array', Array.isArray(ev.events));
  record('EVENTS', 'currentSeq present', typeof ev.currentSeq === 'number', 'seq=' + ev.currentSeq);
  record('EVENTS', 'serverTime present', typeof ev.serverTime === 'number');

  // RESET
  const r1 = await req('POST', '/api/reset-accounts', { scope: 'all' });
  record('RESET', 'POST reset all returns success', r1.body.status === 'success');
  const s3 = (await req('GET', '/api/state')).body;
  record('RESET', 'all 8 accounts back to $50K', Object.values(s3.accounts).every((a) => a.balance === 50000));

  // PAPER
  const paper = (await req('GET', '/api/paper')).body;
  record('PAPER', 'stats + recent + byRegime', !!paper.stats && Array.isArray(paper.recent) && Array.isArray(paper.byRegime));

  // DECISIONS
  const dec = (await req('GET', '/api/decisions')).body;
  record('DECISIONS', 'returns object', !!dec.decisions);

  // BACKTEST
  const bt = await req('POST', '/api/backtest', { action: 'report' });
  record('BACKTEST', 'report returns summary', !!bt.body.summary, 'WR=' + (bt.body.summary && bt.body.summary.winRate) + '% trades=' + (bt.body.summary && bt.body.summary.totalTrades));
  record('BACKTEST', 'reportGeneratedAt mtime', !!bt.body.reportGeneratedAt);
  // NOTE: do NOT actually kick off training in audit — would interfere with real training run

  // LEGACY PRESERVED
  const ts = await req('POST', '/api/toggle-symbol', { symbol: 'NQ=F', enabled: false });
  record('LEGACY', 'toggle-symbol OFF', ts.body.status === 'success');
  await req('POST', '/api/toggle-symbol', { symbol: 'NQ=F', enabled: true });
  const amCh = await req('POST', '/api/mode', { symbol: 'NQ=F', mode: 'Standard' });
  record('LEGACY', 'account mode change', amCh.status === 200);
  await req('POST', '/api/mode', { symbol: 'NQ=F', mode: 'Evaluation' });
  const anCh = await req('POST', '/api/account-number', { symbol: 'NQ=F', accountNumber: 'TEST-X' });
  record('LEGACY', 'account-number edit', anCh.body.status === 'success');
  await req('POST', '/api/account-number', { symbol: 'NQ=F', accountNumber: 'APX-NQ-50K' });
  const runAudit = await req('POST', '/api/run-audit');
  record('LEGACY', '/api/run-audit (loss attribution)', runAudit.body.success === true, 'buckets=' + (runAudit.body.buckets ? runAudit.body.buckets.length : 0));

  // SUMMARY
  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.filter((c) => !c.ok).length;
  console.log('\n═════════════════════════════════════════════════════════════════');
  console.log(' RESULT: ' + pass + ' PASS · ' + fail + ' FAIL · ' + checks.length + ' total');
  console.log('═════════════════════════════════════════════════════════════════');
  if (fail > 0) {
    console.log('\nFAILURES:');
    checks.filter((c) => !c.ok).forEach((c) => {
      console.log('  ✗ [' + c.area + '] ' + c.name + (c.detail ? ' — ' + c.detail : ''));
    });
    process.exit(1);
  }
})();
