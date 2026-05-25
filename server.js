// Antigravity v2 — Server entry
// Driven by NT8 bar pushes → regime classifier → GBDT model → decision →
// (optional live order to NT8) + paper trade log. Yahoo path removed.
// Fake backtest/optimize/cognitive-booster gone.

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');

// ── Zero-dependency .env loader ─────────────────────────────────────────────
// Note: shell environment vars take precedence over .env values (standard
// dotenv behavior). The old loader overwrote process.env unconditionally,
// which made PORT=xxx on the command line silently ineffective.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split(/\r?\n/)) {
    if (line.trim().startsWith('#') || !line.includes('=')) continue;
    const parts = line.split('=');
    const key = parts[0].trim();
    let val = parts.slice(1).join('=').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const PORT = process.env.PORT || 3000;
const TRADING_MODE = (process.env.TRADING_MODE || 'paper').toLowerCase(); // 'paper' | 'live'

// ── Modules ─────────────────────────────────────────────────────────────────
const { checkTradingStatus } = require('./lib/scheduleController');
const { getNewsTradingSuspension, fetchEconomicCalendar } = require('./lib/newsCalendar');
const { getYahooFinanceNews } = require('./lib/yahooNews');
const { getActiveSessionRegime } = require('./lib/sessionRegime');
const {
  loadPortfolioState, getPortfolioState, enterTrade, updatePortfolioMetrics,
  closeTrade, transitionToPAAccount
} = require('./lib/paperEngine');
const { sendTelegramMessage } = require('./lib/telegram');
const {
  startNT8BridgeServer, sendSignalToNT8, getCandles, setOnBarCallback
} = require('./lib/nt8Bridge');
const { decide, modelStatus } = require('./lib/decisionEngine');
const { onBarDecision, getStats, getRecentTrades, getStatsByRegime } = require('./lib/paperHarness');
const { recordTrade, getBucketStats, getRetrainFlags, topLossFeatures } = require('./lib/lossAuditor');
const eventBus = require('./lib/eventBus');

// ── Startup ─────────────────────────────────────────────────────────────────
loadPortfolioState();
startNT8BridgeServer();

const livePrices = { 'NQ=F': 0, 'ES=F': 0, 'CL=F': 0, 'GC=F': 0 };
const lastDecisions = { 'NQ=F': null, 'ES=F': null, 'CL=F': null, 'GC=F': null };
const lastRegimes = { 'NQ=F': null, 'ES=F': null, 'CL=F': null, 'GC=F': null };
const serverStartTime = Date.now();

// ── Bar-push hook: NT8 closed a 5m bar → run decision engine ────────────────
setOnBarCallback((symbol, candles) => {
  if (!candles || candles.length < 220) return;
  const last = candles[candles.length - 1];
  livePrices[symbol] = last.close;

  // BAR event (compact — full feature dump is captured on the decision event)
  eventBus.emit('BAR', symbol,
    `BAR close=${last.close} vol=${last.volume || 0}`,
    { close: last.close, time: last.time });

  const decision = decide(symbol, candles);
  lastDecisions[symbol] = decision;

  // Regime change event (when it flips)
  if (decision.regime && decision.regime !== lastRegimes[symbol]) {
    eventBus.emit('REGIME_CHANGE', symbol,
      `regime: ${lastRegimes[symbol] || '—'} → ${decision.regime}`,
      { from: lastRegimes[symbol], to: decision.regime, session: decision.session });
    lastRegimes[symbol] = decision.regime;
  }

  // DECISION event (always — even FLAT, so the operator sees the bot thinking)
  if (decision.action === 'FLAT') {
    eventBus.emit('DECISION', symbol,
      `FLAT — ${decision.reason}`,
      { regime: decision.regime, session: decision.session, probabilities: decision.probabilities });
  } else {
    eventBus.emit('DECISION', symbol,
      `${decision.action} prob=${decision.probability.toFixed(2)} ≥ thresh=${decision.threshold.toFixed(2)} (${decision.regime})`,
      { action: decision.action, prob: decision.probability, threshold: decision.threshold,
        regime: decision.regime, session: decision.session });
  }

  // Paper harness records the bar (handles stop/target hits + new entries)
  const paperEvent = onBarDecision(symbol, decision, last);
  if (paperEvent && paperEvent.event === 'open') {
    const p = paperEvent.position;
    eventBus.emit('ENTRY', symbol,
      `📍 PAPER ${p.direction} @${p.entryPrice.toFixed(2)} SL=${p.stopLoss.toFixed(2)} TP=${p.takeProfit.toFixed(2)} (${p.regime})`,
      { direction: p.direction, entry: p.entryPrice, sl: p.stopLoss, tp: p.takeProfit, regime: p.regime });
  }
  if (paperEvent && paperEvent.event === 'close') {
    const t = paperEvent.trade;
    const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
    eventBus.emit('EXIT', symbol,
      `🏁 PAPER ${t.direction} closed @${t.exitPrice.toFixed(2)} ${pnlStr} (${t.exitReason})`,
      { pnl: t.pnl, pnlR: t.pnlR, exitReason: t.exitReason });

    // Feed closed paper trade into the loss auditor for attribution
    recordTrade({
      symbol: t.symbol,
      session: t.session,
      regime: t.regime,
      direction: t.direction === 'Long' ? 'long' : 'short',
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      featureSnapshot: t.featureSnapshot || {},
      modelProbability: t.probability,
      threshold: t.threshold,
      pnl: t.pnl,
      pnlR: t.pnlR,
      exitReason: t.exitReason
    });
  }

  // Live execution path (only when TRADING_MODE=live and the symbol is enabled)
  if (TRADING_MODE === 'live' && (decision.action === 'BUY' || decision.action === 'SELL')) {
    const acc = getPortfolioState().accounts[symbol];
    if (!acc || acc.enabled === false || acc.activePosition || acc.status === 'FAILED') {
      eventBus.emit('BLOCKED', symbol,
        `signal blocked — ${!acc ? 'no account' : acc.enabled === false ? 'symbol OFF' : acc.activePosition ? 'already in position' : 'account FAILED'}`);
    } else {
      const direction = decision.action === 'BUY' ? 'Long' : 'Short';
      const sessionRegime = {
        ...getActiveSessionRegime(),
        atrStopMultiplier: 1.5,
        atrTargetMultiplier: 2.7,
        atrBreakevenMultiplier: 0.8,
        atrTrailingMultiplier: 1.0
      };
      const strategy = `${decision.regime} ${direction} (p=${decision.probability.toFixed(2)})`;
      const pos = enterTrade(symbol, direction, decision.close, strategy, decision.atr, sessionRegime);
      if (pos) {
        eventBus.emit('ENTRY', symbol,
          `✓ LIVE ${direction} qty=${pos.qty} @${pos.entryPrice.toFixed(2)} SL=${pos.stopLoss.toFixed(2)} TP=${pos.takeProfit.toFixed(2)}`,
          { direction, qty: pos.qty, entry: pos.entryPrice, sl: pos.stopLoss, tp: pos.takeProfit });
        sendSignalToNT8(decision.action, symbol, pos.qty, pos.entryPrice,
          pos.stopLoss, pos.takeProfit, strategy, pos.beTriggerPrice, pos.trailTriggerPrice);
      } else {
        eventBus.emit('BLOCKED', symbol, 'enterTrade refused (sizer returned 0)');
      }
    }
  }
});

eventBus.emit('INFO', null, `Antigravity v2 cockpit boot — mode=${TRADING_MODE}`);

// ── Static file serving ─────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function serveStaticFile(pathname, res) {
  const filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath).toLowerCase();
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404 Not Found');
  }
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ── HTTP server + API ───────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    let reqBody = {};
    if (body) { try { reqBody = JSON.parse(body); } catch (e) {} }

    try {
      // GET /api/state — main dashboard data
      if (pathname === '/api/state' && req.method === 'GET') {
        const schedule = checkTradingStatus();
        const news = await getNewsTradingSuspension();
        const regime = getActiveSessionRegime();
        const portfolioState = getPortfolioState();
        const yahooNews = await getYahooFinanceNews();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ...portfolioState,
          livePrices,
          lastDecisions,
          schedule,
          news,
          regime,
          yahooNews,
          tradingMode: TRADING_MODE,
          tastytradeId: process.env.TASTYTRADE_CLIENT_ID
        }));
      }

      // POST /api/close — force close a symbol's position
      if (pathname === '/api/close' && req.method === 'POST') {
        const { symbol } = reqBody;
        const ps = getPortfolioState();
        const acc = ps.accounts[symbol];
        if (acc && acc.activePosition) {
          const exitPrice = livePrices[symbol] || acc.activePosition.entryPrice;
          closeTrade(symbol, exitPrice, 'Forced Close via Dashboard');
          sendSignalToNT8('CLOSE', symbol, 0, 0, 0, 0);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'success' }));
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No active position to close' }));
      }

      // POST /api/transition — promote eval → PA
      if (pathname === '/api/transition' && req.method === 'POST') {
        const success = transitionToPAAccount(reqBody.symbol);
        res.writeHead(success ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: success ? 'success' : 'failed' }));
      }

      // POST /api/mode — change account mode
      if (pathname === '/api/mode' && req.method === 'POST') {
        const { changeAccountMode } = require('./lib/paperEngine');
        const success = changeAccountMode(reqBody.symbol, reqBody.mode);
        res.writeHead(success ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: success ? 'success' : 'failed' }));
      }

      // POST /api/account-number — update account label
      if (pathname === '/api/account-number' && req.method === 'POST') {
        const { updateAccountNumber } = require('./lib/paperEngine');
        const success = updateAccountNumber(reqBody.symbol, reqBody.accountNumber);
        res.writeHead(success ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: success ? 'success' : 'failed' }));
      }

      // POST /api/toggle-symbol — symbol ON/OFF
      if (pathname === '/api/toggle-symbol' && req.method === 'POST') {
        const { toggleSymbolEnabled } = require('./lib/paperEngine');
        const success = toggleSymbolEnabled(reqBody.symbol, reqBody.enabled, livePrices[reqBody.symbol]);
        res.writeHead(success ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: success ? 'success' : 'failed' }));
      }

      // POST /api/webhook — persist Google Sheets URL
      if (pathname === '/api/webhook' && req.method === 'POST') {
        const { url: webhookUrl } = reqBody;
        process.env.GOOGLE_SHEETS_WEBHOOK_URL = webhookUrl;
        if (fs.existsSync(envPath)) {
          let envContent = fs.readFileSync(envPath, 'utf-8');
          envContent = envContent.includes('GOOGLE_SHEETS_WEBHOOK_URL=')
            ? envContent.replace(/GOOGLE_SHEETS_WEBHOOK_URL=.*/, `GOOGLE_SHEETS_WEBHOOK_URL=${webhookUrl}`)
            : envContent + `\nGOOGLE_SHEETS_WEBHOOK_URL=${webhookUrl}`;
          fs.writeFileSync(envPath, envContent, 'utf-8');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'success' }));
      }

      // POST /api/backtest — returns the LATEST walkforward report (real numbers)
      // Replaces the old hardcoded LSTM/MTF/EMA simulator.
      if (pathname === '/api/backtest' && req.method === 'POST') {
        const reportPath = path.join(__dirname, 'models', 'latest_report.json');
        if (!fs.existsSync(reportPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            results: '⚠️  No training report found. Run: node scripts/train.js --quick',
            summary: { totalProfitPercent: 0, drawdownPercent: 0, winRate: 0, profitFactor: 0, totalTrades: 0 },
            chartData: []
          }));
        }
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
        const formatted = _formatBacktestReport(report, reqBody);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(formatted));
      }

      // POST /api/optimize — kicks off a real walkforward retrain (background)
      if (pathname === '/api/optimize' && req.method === 'POST') {
        const { spawn } = require('child_process');
        const args = ['scripts/train.js', '--quick'];
        const child = spawn('node', args, { cwd: __dirname, detached: true, stdio: 'ignore' });
        child.unref();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          results: '🧠 Walkforward retrain started in background. Check the Models endpoint or re-open this tab in ~5-15 minutes.',
          summary: { totalProfitPercent: 0, drawdownPercent: 0, winRate: 0, profitFactor: 0, totalTrades: 0 },
          chartData: []
        }));
      }

      // POST /api/run-audit — runs loss-attribution report (NOT auto-tuning)
      if (pathname === '/api/run-audit' && req.method === 'POST') {
        const buckets = getBucketStats();
        const topFeatures = topLossFeatures(null, 10);
        const flags = getRetrainFlags();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          buckets,
          topLossFeatures: topFeatures,
          retrainFlags: flags,
          stats: getRecentTrades(30),
          settings: _legacySettingsShim()
        }));
      }

      // GET /api/models — list trained model bundles + their walkforward metrics
      if (pathname === '/api/models' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ models: modelStatus() }));
      }

      // GET /api/paper — paper trade history + stats
      if (pathname === '/api/paper' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          stats: getStats(),
          byRegime: getStatsByRegime(),
          recent: getRecentTrades(50)
        }));
      }

      // GET /api/decisions — latest decision per symbol (for live regime/prob display)
      if (pathname === '/api/decisions' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ decisions: lastDecisions }));
      }

      // GET /api/events?after=N&symbol=NQ%3DF&errorsOnly=1&types=ENTRY,EXIT
      // Polled by the Trading Floor Terminal's live event stream pane.
      // Returns events with seq > after, optionally filtered.
      if (pathname === '/api/events' && req.method === 'GET') {
        const after = parseInt(url.searchParams.get('after') || '0', 10);
        const symbolFilter = url.searchParams.get('symbol') || null;
        const errorsOnly = url.searchParams.get('errorsOnly') === '1';
        const typesParam = url.searchParams.get('types');
        const types = typesParam ? typesParam.split(',') : null;
        const events = eventBus.getEvents(after, { symbol: symbolFilter, errorsOnly, types });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          events,
          currentSeq: eventBus.currentSeq(),
          serverTime: Date.now()
        }));
      }

      // Default: static files
      serveStaticFile(pathname, res);
    } catch (err) {
      console.error('[Server] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

// Build the chart payload + log text the dashboard expects.
function _formatBacktestReport(report, reqBody) {
  const algo = reqBody && reqBody.algorithm ? reqBody.algorithm : 'Antigravity v2 GBDT';
  let text = `=== ANTIGRAVITY v2 — REAL WALKFORWARD REPORT ===\n`;
  text += `Generated:      ${report.trainedAt}\n`;
  text += `Training time:  ${report.durationSec}s\n`;
  text += `Engine:         Regime-aware GBDT (per regime × session × direction)\n`;
  text += `Algorithm:      ${algo}\n\n`;

  // Aggregate across all bundles for the headline KPI
  let totalTrades = 0, weightedWR = 0, weightedPF = 0, maxDD = 0, weightSum = 0;
  const chartData = [];
  let cumulativeR = 0, peakR = 0;
  let pointIdx = 0;

  for (const rpt of (report.symbols || [])) {
    const sym = rpt.symbol.replace('=F', '');
    text += `── ${sym} ──\n`;
    for (const [key, b] of Object.entries(rpt.bundles)) {
      if (!b.trained) {
        text += `  ${key.padEnd(34)} SKIPPED (${b.reason})\n`;
        continue;
      }
      const a = b.aggregate;
      totalTrades += a.totalTestTrades;
      weightedWR += a.winRate * a.totalTestTrades;
      weightedPF += a.profitFactor * a.totalTestTrades;
      weightSum += a.totalTestTrades;
      if (a.maxDD > maxDD) maxDD = a.maxDD;
      const status = b.deployed ? 'deployed' : 'rolled back';
      text += `  ${key.padEnd(34)} trades=${String(a.totalTestTrades).padEnd(5)} ` +
              `WR=${(a.winRate*100).toFixed(1)}% PF=${a.profitFactor.toFixed(2)} ` +
              `Sharpe=${a.sharpe.toFixed(2)} thresh=${b.threshold.toFixed(2)} [${status}]\n`;
      // Add a chart point per bundle showing cumulative R progression
      cumulativeR += a.totalTestTrades * (a.winRate * 1.8 - (1 - a.winRate) * 1.0);
      if (cumulativeR > peakR) peakR = cumulativeR;
      const dd = peakR - cumulativeR;
      chartData.push({
        pointIndex: pointIdx++,
        date: `${sym} ${key.slice(0, 12)}`,
        profit: parseFloat(cumulativeR.toFixed(1)),
        drawdown: parseFloat(dd.toFixed(1))
      });
    }
    text += `\n`;
  }

  const aggregateWR = weightSum > 0 ? weightedWR / weightSum : 0;
  const aggregatePF = weightSum > 0 ? weightedPF / weightSum : 0;
  text += `── AGGREGATE ──\n`;
  text += `  Total test trades:   ${totalTrades}\n`;
  text += `  Weighted win rate:   ${(aggregateWR*100).toFixed(1)}%\n`;
  text += `  Weighted profit factor: ${aggregatePF.toFixed(2)}\n`;
  text += `  Worst single-bundle max DD: ${maxDD.toFixed(1)} R\n`;

  return {
    results: text,
    summary: {
      totalProfitPercent: parseFloat((cumulativeR * 0.5).toFixed(1)),  // R → rough % at 0.5%/R
      drawdownPercent: parseFloat((maxDD * 0.5).toFixed(1)),
      winRate: parseFloat((aggregateWR * 100).toFixed(1)),
      profitFactor: parseFloat(aggregatePF.toFixed(2)),
      totalTrades
    },
    chartData
  };
}

// Legacy shim: the old dashboard expects optimized_settings.json structure.
// Map current model thresholds into something it can render.
function _legacySettingsShim() {
  const models = modelStatus();
  const out = {};
  for (const m of models) {
    if (!out[m.symbol]) out[m.symbol] = { RTH: {}, ETH: {} };
    const sess = out[m.symbol][m.session] || {};
    sess[`${m.regime}_${m.direction}_threshold`] = m.threshold;
    out[m.symbol][m.session] = sess;
    // Provide a couple of fake legacy keys so the existing dashboard JS doesn't crash
    if (!sess.emaFast) sess.emaFast = 9;
    if (!sess.emaSlow) sess.emaSlow = 21;
    if (!sess.bbStdDev) sess.bbStdDev = 2.0;
    if (!sess.rsiOversold) sess.rsiOversold = 30;
    if (!sess.rsiOverbought) sess.rsiOverbought = 70;
  }
  // Ensure all 4 symbols have entries so the dashboard renders
  for (const s of ['NQ=F', 'ES=F', 'CL=F', 'GC=F']) {
    if (!out[s]) out[s] = {
      RTH: { emaFast: 9, emaSlow: 21 },
      ETH: { bbStdDev: 2.0, rsiOversold: 30, rsiOverbought: 70 }
    };
  }
  return out;
}

// ── Live-price ticker (low-frequency, mirrors NT8 reality) ──────────────────
// Old code spammed Yahoo every 2s. New behavior: prices update only when NT8
// pushes a BAR. updatePortfolioMetrics still gets called to compute equity
// curves and trigger SL/TP exits on positions opened via /api/state path.
setInterval(() => {
  const regime = getActiveSessionRegime();
  updatePortfolioMetrics(livePrices, {
    ...regime,
    atrBreakevenMultiplier: 0.8,
    atrTrailingMultiplier: 1.0
  });
}, 5000);

// ── Startup ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
  console.log(`║   ANTIGRAVITY v2 — Cockpit Server                            ║`);
  console.log(`╠════════════════════════════════════════════════════════════════╣`);
  console.log(`║   Web:        http://localhost:${PORT}                            ║`);
  console.log(`║   NT8 Bridge: 0.0.0.0:4000  (NT8 sends BAR + METRICS)        ║`);
  console.log(`║   Mode:       ${TRADING_MODE.toUpperCase().padEnd(7)} (set TRADING_MODE=live to enable orders)║`);
  console.log(`║   Engine:     Regime-aware GBDT × 24 models (4 sym × 2 sess × 3 reg × 2 dir)║`);
  console.log(`╚════════════════════════════════════════════════════════════════╝\n`);

  sendTelegramMessage(`🚀 Antigravity v2 cockpit online — mode=${TRADING_MODE}. Listening for NT8 bars on TCP 4000.`);
  fetchEconomicCalendar().catch(() => console.log('[Startup] Economic calendar fetch deferred.'));
});
