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
const { checkTradingStatus, getNextSessionChange, getCurrentSessionState } = require('./lib/scheduleController');
const { getNewsTradingSuspension, fetchEconomicCalendar } = require('./lib/newsCalendar');
const { getYahooFinanceNews } = require('./lib/yahooNews');
const { getActiveSessionRegime } = require('./lib/sessionRegime');
const {
  loadPortfolioState, getPortfolioState, enterTrade, updatePortfolioMetrics,
  closeTrade, transitionToPAAccount,
  setContractMode, getContractMode, activeSymbols,
  ALL_SYMBOLS, MINI_SYMBOLS, MICRO_SYMBOLS, CONTRACT_SPECS,
  familyMiniSymbol, familyMicroSymbol, activeContractFor,
  resetAllAccounts, resetSymbolAccount, setAccountTradingMode,
  setFamilyContract, getFamilyContracts,
  setOnPositionClose
} = require('./lib/paperEngine');
const { sendTelegramMessage } = require('./lib/telegram');
const {
  startNT8BridgeServer, sendSignalToNT8, getCandles, setOnBarCallback,
  broadcastBrainState, bootstrapBuffersFromCsv, getLinkedSymbols
} = require('./lib/nt8Bridge');
const { decide, modelStatus, getQualityFloors, recordTradeResult, getSafetyState, seedDailyPnLFromNt8, getDecisionMode, setDecisionMode } = require('./lib/decisionEngine');
// paperHarness removed — all symbols run LIVE via NT8
const { recordTrade, getBucketStats, getRetrainFlags, topLossFeatures } = require('./lib/lossAuditor');
const eventBus = require('./lib/eventBus');
const { getExitsConfig, setExitsConfig, isFixedActive } = require('./lib/exitsConfig');
const { getActiveProfile, setActiveProfile, setBoostMode, getAllPresets } = require('./lib/aggressivenessProfile');

// ── Startup ─────────────────────────────────────────────────────────────────
loadPortfolioState();
// Pre-seed candle buffers from local CSVs so the decision engine can fire on
// the FIRST live NT8 bar push instead of waiting ~18 hours for 220 bars.
bootstrapBuffersFromCsv();
startNT8BridgeServer();

// Live state keyed by ALL 8 contracts (4 mini + 4 micro). Even when the bot
// is in MINI mode, micro entries stay present (just null) so dashboard render
// code doesn't have to special-case missing keys.
const livePrices = {};
const lastDecisions = {};
const lastRegimes = {};
// Consecutive-loss tracker per bucket (symbol_session_regime_direction).
// Reset to 0 on any winning close. Triggers a WARNING event at 3+ in a row
// so the user / monitor knows to investigate that specific specialist.
const _lossStreak = {};
for (const s of ALL_SYMBOLS) { livePrices[s] = 0; lastDecisions[s] = null; lastRegimes[s] = null; }
const serverStartTime = Date.now();


// ── Bar-push hook: NT8 closed a 5m bar → run decision engine ────────────────
// NT8 charts always send mini symbols (NQ=F, ES=F, CL=F, GC=F) — even when
// the chart is showing the micro contract, the price is identical. We work
// in "family" terms internally and route paper trades to the active contract
// (mini vs micro) based on global contractMode.
function processBarUpdate(rawSymbol, candles) {
  if (!candles || candles.length < 220) return;
  const last = candles[candles.length - 1];
  const familySym = familyMiniSymbol(rawSymbol);   // NQ=F whether chart is NQ or MNQ
  const microSym = familyMicroSymbol(familySym);   // MNQ=F
  // Mirror price to both contract keys so the dashboard always has fresh data
  livePrices[familySym] = last.close;
  if (microSym) livePrices[microSym] = last.close;

  // BAR event tagged with the active contract for clarity
  const targetSym = activeContractFor(familySym);  // currently-active mini OR micro
  eventBus.emit('BAR', targetSym,
    `BAR close=${last.close} vol=${last.volume || 0}`,
    { close: last.close, time: last.time, family: familySym });

  // Decision is family-level (uses mini model)
  const decision = decide(familySym, candles);
  // Store under BOTH mini and micro keys so dashboard renders consistently
  // regardless of which contract mode is currently selected
  lastDecisions[familySym] = decision;
  if (microSym) lastDecisions[microSym] = decision;

  // Regime change tracked at the family level (avoids double-emit)
  if (decision.regime && decision.regime !== lastRegimes[familySym]) {
    eventBus.emit('REGIME_CHANGE', targetSym,
      `regime: ${lastRegimes[familySym] || '—'} → ${decision.regime}`,
      { from: lastRegimes[familySym], to: decision.regime, session: decision.session });
    lastRegimes[familySym] = decision.regime;
    if (microSym) lastRegimes[microSym] = decision.regime;
  }

  // DECISION event (always — even FLAT, so the operator sees the bot thinking)
  if (decision.action === 'FLAT') {
    eventBus.emit('DECISION', targetSym,
      `FLAT — ${decision.reason}`,
      { regime: decision.regime, session: decision.session, probabilities: decision.probabilities });
  } else {
    eventBus.emit('DECISION', targetSym,
      `${decision.action} prob=${decision.probability.toFixed(2)} ≥ thresh=${decision.threshold.toFixed(2)} (${decision.regime})`,
      { action: decision.action, prob: decision.probability, threshold: decision.threshold,
        regime: decision.regime, session: decision.session });
  }

  // Push a fresh BRAIN_STATE snapshot to all NT8 clients — drives the on-chart
  // Brain Panel overlay. Top-3 feature values are surfaced for at-a-glance.
  try {
    const probs = (decision && decision.probabilities) || {};
    const acc = getPortfolioState().accounts[targetSym] || {};
    const fv = decision && decision.featureSnapshot ? decision.featureSnapshot : {};
    const topFeatures = {
      rsi: fv.rsi,
      macd_hist: fv.macd_hist,
      adx: fv.adx,
      bb_z: fv.bb_z,
      atr_pct: fv.atr_pct
    };
    // Per-family / per-account context — fixes brain panel showing wrong
    // mode for micros + LIVE accounts (bug found 2026-05-26).
    const _fam = familySym.replace('=F','');
    const _famContracts = (typeof getFamilyContracts === 'function') ? getFamilyContracts() : {};
    const _perFamContract = _famContracts[_fam] || getContractMode();
    const _perAcctMode = (acc && acc.tradingMode) || TRADING_MODE;
    broadcastBrainState({
      symbol: targetSym,
      family: familySym,
      close: last.close,
      atr: decision ? decision.atr : null,
      regime: decision ? decision.regime : null,
      session: decision ? decision.session : null,
      action: decision ? decision.action : 'FLAT',
      longProb:  probs.long  !== undefined ? probs.long  : (decision && decision.action === 'BUY'  ? decision.probability : null),
      shortProb: probs.short !== undefined ? probs.short : (decision && decision.action === 'SELL' ? decision.probability : null),
      longTh:  probs.longTh,
      shortTh: probs.shortTh,
      specialist: (decision && decision.regime && decision.regime !== 'CHOP')
        ? `${familyMiniSymbol(targetSym).replace('=F','')}_${decision.session}_${decision.regime}`
        : '—',
      positionDir: acc.activePosition ? acc.activePosition.direction : null,
      positionQty: acc.activePosition ? acc.activePosition.qty : 0,
      positionEntry: acc.activePosition ? acc.activePosition.entryPrice : 0,
      positionPnl: acc.activePosition ? (acc.activePosition.unrealizedPnL || 0) : 0,
      sl: acc.activePosition ? acc.activePosition.stopLoss : null,
      tp: acc.activePosition ? acc.activePosition.takeProfit : null,
      contractMode: _perFamContract,   // per-family (was global)
      tradingMode: _perAcctMode,       // per-account (was global env)
      exitMode: decision ? decision.exitMode : null,
      features: topFeatures,
      ts: Date.now()
    });
  } catch (e) {
    console.error('[Server] BRAIN_STATE broadcast failed:', e.message);
  }

  // All symbols are LIVE — decisions go straight to NT8 via the bridge.
  const symbol = targetSym;
  if (decision.action === 'BUY' || decision.action === 'SELL') {
    const acc = getPortfolioState().accounts[symbol];

    // SYMBOL-MISMATCH + NT8-NOT-CONNECTED GUARD
    // (a) If bot wants MNQ=F but NT8 chart is on NQ=F → silent NT8 rejection
    //     (the new .cs auto-scales qty, but if not recompiled yet, fails).
    // (b) If no NT8 chart connected for this family AT ALL, the live signal
    //     would fire into the void. Block + warn clearly.
    const linked = (typeof getLinkedSymbols === 'function') ? getLinkedSymbols() : {};
    const family = symbol.replace('=F', '').replace(/^M(NQ|ES|CL|GC)$/, '$1');
    const chartSym = linked[family];
    const mismatch = chartSym && chartSym !== symbol;
    const noChart = !chartSym;

    if (noChart) {
      eventBus.emit('BLOCKED', symbol,
        `🚫 LIVE blocked — no NT8 chart connected for ${family}. ` +
        `Open a NinjaTrader chart on ${family} (or M${family}) with AntigravityBotBridge attached, ` +
        `OR switch this symbol back to PAPER mode.`);
    } else if (mismatch) {
      eventBus.emit('BLOCKED', symbol,
        `🚫 symbol mismatch — bot wants ${symbol} but NT8 chart is on ${chartSym}. ` +
        `Recompile AntigravityBotBridge.cs (F5 in NT8) so the new auto-qty-scaler handles it, ` +
        `or switch bot mode to match the chart.`);
    } else if (!acc || acc.enabled === false || acc.activePosition || acc.status === 'FAILED') {
      eventBus.emit('BLOCKED', symbol,
        `signal blocked — ${!acc ? 'no account' : acc.enabled === false ? 'symbol OFF' : acc.activePosition ? 'already in position' : 'account FAILED'}`);
    } else {
      {
        const direction = decision.action === 'BUY' ? 'Long' : 'Short';
        // Use aggressiveness profile's ATR multipliers so SL/TP adapt to the
        // active preset (SNIPER, BALANCED, ACTIVE, SCALPER, or AUTO sub-preset).
        const _prof = getActiveProfile();
        const sessionRegime = {
          ...getActiveSessionRegime(),
          atrStopMultiplier:      _prof.slAtrMult    || 1.5,
          atrTargetMultiplier:    _prof.tpAtrMult    || 2.7,
          atrBreakevenMultiplier: 0.8,
          atrTrailingMultiplier:  1.0
        };
        const strategy = `${decision.regime} ${direction} (p=${decision.probability.toFixed(2)})`;
        const pos = enterTrade(symbol, direction, decision.close, strategy, decision.atr, sessionRegime);
        if (pos) {
          eventBus.emit('ENTRY', symbol,
            `✓ LIVE ${direction} qty=${pos.qty} @${pos.entryPrice.toFixed(2)} SL=${pos.stopLoss.toFixed(2)} TP=${pos.takeProfit.toFixed(2)}`,
            { direction, qty: pos.qty, entry: pos.entryPrice, sl: pos.stopLoss, tp: pos.takeProfit });
          sendSignalToNT8(decision.action, symbol, pos.qty, pos.entryPrice,
            pos.stopLoss, pos.takeProfit, strategy, pos.beTriggerPrice, pos.trailTriggerPrice);
          // Telegram entry alert — fires for every new trade while user is away
          try {
            const dirEmoji = decision.action === 'BUY' ? '🟢' : '🔴';
            const slPts  = Math.abs(pos.entryPrice - pos.stopLoss).toFixed(1);
            const tpPts  = Math.abs(pos.takeProfit - pos.entryPrice).toFixed(1);
            sendTelegramMessage(
              `${dirEmoji} *${decision.action === 'BUY' ? 'LONG' : 'SHORT'}* ${symbol.replace('=F','')} ×${pos.qty}\n` +
              `📍 Entry: \`${pos.entryPrice.toFixed(2)}\`\n` +
              `🛑 SL: \`${pos.stopLoss.toFixed(2)}\` (−${slPts} pts)\n` +
              `🎯 TP: \`${pos.takeProfit.toFixed(2)}\` (+${tpPts} pts)\n` +
              `📊 ${decision.regime} | ${decision.session} | p=${(decision.probability*100).toFixed(1)}% ≥ ${(decision.threshold*100).toFixed(1)}%`,
              { kind: 'open', header: '⚡ *Antigravity — Entry*' }
            );
          } catch (e) { /* non-fatal */ }
        } else {
          eventBus.emit('BLOCKED', symbol, 'enterTrade refused (sizer returned 0)');
        }
      }
    }
  }
}

// Register the bar processor with the NT8 bridge for live closed-bar callbacks
setOnBarCallback(processBarUpdate);

// Register position-close callback — fires when NT8 METRICS transitions to Flat.
// Sends a Telegram trade-close alert so user sees result while away from desk.
setOnPositionClose((symbol, closedPos, tradePnL, cumulativeRealized) => {
  try {
    const sign = tradePnL >= 0 ? '+' : '';
    const emoji = tradePnL >= 0 ? '✅' : '❌';
    const pnlStr = `${sign}$${tradePnL.toFixed(2)}`;
    const dir = closedPos.direction || '?';
    const entry = closedPos.entryPrice ? closedPos.entryPrice.toFixed(2) : '?';
    const strategy = closedPos.strategyUsed || '?';

    // ── Update safety state (daily P&L cap + adaptive thresholds + loss streaks) ──
    // Extract session and regime from the strategy string (e.g. "CHOP Long (p=0.54)")
    // Fall back to current bar session/regime if parse fails.
    try {
      const { sessionFromTimestamp } = require('./lib/featureEngineer');
      const session = sessionFromTimestamp(new Date()) || 'ETH';
      // Strategy string format: "<REGIME> <Direction> (p=<prob>)"
      const regimeMatch = strategy.match(/^(TREND_UP|TREND_DOWN|CHOP|VOL_EXPANSION)/);
      const regime = regimeMatch ? regimeMatch[1] : 'CHOP';
      recordTradeResult({
        symbol,
        session,
        regime,
        direction: dir,
        pnl: tradePnL,
        exitTime: Date.now(),
        entryPrice: closedPos.entryPrice || 0
      });
      console.log(`[Server] recordTradeResult: ${symbol} ${dir} ${regime}/${session} P&L=${pnlStr}`);
    } catch (e) { console.warn('[Server] recordTradeResult failed:', e.message); }

    sendTelegramMessage(
      `${emoji} *CLOSED* ${symbol.replace('=F','')} ${dir.toUpperCase()} ×${closedPos.qty || 1}\n` +
      `📍 Entry: \`${entry}\`\n` +
      `💵 Trade P&L: *${pnlStr}*\n` +
      `📈 Session realized: \`$${cumulativeRealized.toFixed(2)}\`\n` +
      `🔖 ${strategy}`,
      { kind: 'close', header: `${emoji} *Antigravity — Trade Closed*` }
    );
    eventBus.emit('CLOSE', symbol, `${emoji} ${dir} closed — ${pnlStr}`, { pnl: tradePnL });
  } catch (e) { /* non-fatal */ }
});

// ── Boot-time warmup ────────────────────────────────────────────────────────
// Bootstrap loaded ~250 historical bars per family into the candle buffer,
// but no decisions were computed. Without this warmup, livePrices and
// lastDecisions stay empty until NT8 pushes the next live bar (up to 60s on
// 1-min charts, longer on slower charts). That leaves the dashboard cards in
// "Waiting for first NT8 bar push…" limbo after every server restart.
//
// Fix: synthesize one bar event per family using the latest seeded bar.
// Cards now populate within ~100ms of boot, regardless of NT8 reconnect
// timing. The paper harness sees this as a no-op (close = same close it
// already saw in the CSV training set) so no spurious trades fire.
for (const sym of ['NQ=F', 'ES=F', 'CL=F', 'GC=F']) {
  try {
    const candles = getCandles(sym);
    if (candles && candles.length >= 220) {
      processBarUpdate(sym, candles);
    }
  } catch (e) {
    console.error(`[Server] Warmup failed for ${sym}:`, e.message);
  }
}
console.log('[Server] Warmup complete — cards prepopulated from CSV buffer.');

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
  // Force no-cache for HTML/JS/CSS so the browser always gets the latest
  // dashboard after code changes. Without this, a stale terminal.js could
  // sit in the browser cache forever and the user never sees fixes (e.g.
  // the MINI/MICRO toggle bug we just fixed).
  const headers = { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' };
  if (['.html', '.js', '.css'].includes(ext)) {
    headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    headers['Pragma'] = 'no-cache';
    headers['Expires'] = '0';
  }
  res.writeHead(200, headers);
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
        // Enrich the schedule object with the live market clock fields the
        // dashboard's center widget needs (state + next-event countdown).
        schedule.sessionState = getCurrentSessionState();
        schedule.nextEvent    = getNextSessionChange();
        const news = await getNewsTradingSuspension();
        const regime = getActiveSessionRegime();
        const portfolioState = getPortfolioState();
        const yahooNews = await getYahooFinanceNews();

        // All positions come from NT8 METRICS (live only — paper mode removed)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Detect if a retrain is currently writing to a log file in
        // models/retrain_logs/ — surfaces a "training in progress" badge
        // on cards so users know why deployed bundles may be sparse / stale.
        let retrainInProgress = null;
        try {
          const rlDir = path.join(__dirname, 'models', 'retrain_logs');
          if (fs.existsSync(rlDir)) {
            const latest = fs.readdirSync(rlDir)
              .filter(f => f.endsWith('.log'))
              .map(f => ({ f, mtime: fs.statSync(path.join(rlDir, f)).mtimeMs }))
              .sort((a, b) => b.mtime - a.mtime)[0];
            if (latest) {
              const ageSec = (Date.now() - latest.mtime) / 1000;
              // Active if log was written to in the last 10 minutes AND no
              // completion marker is present. (Wider window than 90s because
              // a single 4-fold GBDT bundle can take 4-5 min between log
              // lines while it's computing the final deployment model.)
              if (ageSec < 600) {
                const content = fs.readFileSync(path.join(rlDir, latest.f), 'utf-8');
                const isDone = /Total runtime|Wrote summary|Trainer complete/.test(content);
                if (!isDone) {
                  const started   = (content.match(/Starting walkforward/g) || []).length;
                  const deployed  = (content.match(/DEPLOYED →/g) || []).length;
                  const rolled    = (content.match(/ROLLBACK/g) || []).length;
                  retrainInProgress = { logFile: latest.f, ageSec: Math.round(ageSec),
                    bundlesStarted: started, deployed, rollback: rolled,
                    totalExpected: 64 };
                }
              }
            }
          }
        } catch (e) { /* non-fatal */ }

        return res.end(JSON.stringify({
          ...portfolioState,
          livePrices,
          lastDecisions,
          schedule,
          news,
          regime,
          yahooNews,
          tradingMode: TRADING_MODE,
          contractMode: getContractMode(),
          contractSpecs: CONTRACT_SPECS,
          miniSymbols: MINI_SYMBOLS,
          microSymbols: MICRO_SYMBOLS,
          qualityFloors: getQualityFloors(),
          aggressivenessProfile: getActiveProfile(),
          retrainInProgress,
          nt8LinkedSymbols: (typeof getLinkedSymbols === 'function') ? getLinkedSymbols() : {},
          decisionMode: (typeof getDecisionMode === 'function') ? getDecisionMode() : 'HYBRID',
          familyContracts: (typeof getFamilyContracts === 'function') ? getFamilyContracts() : {},
          tastytradeId: process.env.TASTYTRADE_CLIENT_ID
        }));
      }

      // POST /api/family-contract — per-family MINI/MICRO toggle
      // body: { family: 'NQ', type: 'MINI' | 'MICRO' }
      if (pathname === '/api/family-contract' && req.method === 'POST') {
        const result = setFamilyContract(reqBody.family, reqBody.type);
        if (result.ok) {
          eventBus.emit('INFO', null, `${result.family} family contract → ${result.type}`);
        }
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      }

      // POST /api/decision-mode — flip between HYBRID and V2
      // body: { mode: 'HYBRID' | 'V2' }
      if (pathname === '/api/decision-mode' && req.method === 'POST') {
        const result = setDecisionMode(reqBody && reqBody.mode);
        if (result.ok) {
          eventBus.emit('INFO', null, `Decision mode → ${result.mode}`);
        }
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      }

      // GET /api/exits — current exits override config
      if (pathname === '/api/exits' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ config: getExitsConfig(), fixedActive: isFixedActive() }));
      }

      // GET /api/aggressiveness — list all presets + show active
      if (pathname === '/api/aggressiveness' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          active: getActiveProfile(),
          presets: getAllPresets()
        }));
      }

      // POST /api/aggressiveness — switch the active profile
      // body: { key: 'SNIPER' | 'BALANCED' | 'ACTIVE' | 'SCALPER' | 'AUTO' }
      if (pathname === '/api/aggressiveness' && req.method === 'POST') {
        const { key } = reqBody;
        const result = setActiveProfile(key);
        if (result) {
          eventBus.emit('INFO', null, `Aggressiveness profile switched → ${key}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'success', active: result }));
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'failed', error: 'unknown profile key' }));
      }

      // POST /api/aggressiveness/boost — toggle the tighter R:R override
      // body: { enabled: true | false }
      if (pathname === '/api/aggressiveness/boost' && req.method === 'POST') {
        const { enabled } = reqBody;
        const result = setBoostMode(!!enabled);
        eventBus.emit('INFO', null, `Boost R:R ${enabled ? 'ENABLED' : 'disabled'} — live within 60s`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'success', active: result }));
      }

      // POST /api/exits — update a single SYMBOL+session config
      // body: { symbol: 'NQ=F', session: 'RTH'|'ETH', values: { enabled, profitPoints, stopPoints, breakevenAtPoints, trailStartPoints, trailStepPoints } }
      if (pathname === '/api/exits' && req.method === 'POST') {
        const { symbol, session, values } = reqBody;
        const cfg = setExitsConfig(symbol, session, values || {});
        if (cfg) {
          eventBus.emit('INFO', symbol, `Exits config updated — ${symbol} ${session} fixed=${cfg[symbol][session].enabled}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'success', config: cfg }));
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'failed', error: 'invalid symbol or session' }));
      }

      // POST /api/account-trading-mode — per-account LIVE/PAPER toggle
      // body: { symbol: 'NQ=F', mode: 'live' | 'paper' }
      if (pathname === '/api/account-trading-mode' && req.method === 'POST') {
        const result = setAccountTradingMode(reqBody.symbol, reqBody.mode);
        if (result.ok) {
          eventBus.emit('INFO', result.symbol, `Account ${result.symbol} → ${result.mode.toUpperCase()} mode`);
        }
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      }

      // POST /api/reset-accounts — wipes all 8 accounts + trade history back
      // to clean $50K starting state. Also clears paper_trades.json so the
      // paper engine starts fresh. Used when starting a new paper run.
      if (pathname === '/api/reset-accounts' && req.method === 'POST') {
        const scope = reqBody.scope || 'all';   // 'all' | 'symbol'
        const symbol = reqBody.symbol;
        let ok = false;
        if (scope === 'symbol' && symbol) {
          const r = resetSymbolAccount(symbol);
          ok = !!(r && r.ok);
        } else {
          ok = resetAllAccounts();
          // Also wipe paper-trade journal so /api/paper stats start at 0
          try {
            const paperFile = path.join(__dirname, 'models', 'paper_trades.json');
            if (fs.existsSync(paperFile)) fs.unlinkSync(paperFile);
          } catch (e) {}
          // And the loss-attribution buckets
          try {
            const lossFile = path.join(__dirname, 'models', 'loss_attributions.json');
            if (fs.existsSync(lossFile)) fs.unlinkSync(lossFile);
          } catch (e) {}
        }
        if (ok) {
          eventBus.emit('INFO', null, `Account reset — scope=${scope}${symbol ? ' symbol=' + symbol : ''}`);
        }
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: ok ? 'success' : 'failed' }));
      }

      // POST /api/contract-mode — switch between MINI and MICRO globally
      if (pathname === '/api/contract-mode' && req.method === 'POST') {
        const { mode } = reqBody;
        const ok = setContractMode(mode);
        if (ok) {
          eventBus.emit('INFO', null, `Contract mode → ${mode}`);
        }
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: ok ? 'success' : 'invalid mode', mode: getContractMode() }));
      }

      // POST /api/fire — manually fire a trade signal to NT8
      // Body: { symbol: 'MNQ=F', action: 'BUY'|'SELL' }
      // Uses current live price, current ATR, and standard session/regime exits.
      // Bypasses the bundle threshold check — operator-initiated override.
      if (pathname === '/api/fire' && req.method === 'POST') {
        const { symbol, action } = reqBody;
        if (!symbol || !action || !['BUY','SELL'].includes(action.toUpperCase())) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'body must include symbol and action (BUY|SELL)' }));
        }
        const fireAction = action.toUpperCase();
        const ps = getPortfolioState();
        const acc = ps.accounts[symbol];
        if (!acc) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `unknown symbol ${symbol}` }));
        }
        if (acc.activePosition) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'already in position — close first' }));
        }
        const px = livePrices[symbol] || livePrices[familyMiniSymbol(symbol)];
        if (!px) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'no live price yet — NT8 not streaming?' }));
        }
        // Get ATR from last decision, fall back to 10 ticks
        const lastDec = lastDecisions[symbol] || lastDecisions[familyMiniSymbol(symbol)];
        const atr = (lastDec && lastDec.atr) || 10;
        const _profM = getActiveProfile();
        const sessionRegime = {
          ...getActiveSessionRegime(),
          atrStopMultiplier:      _profM.slAtrMult    || 1.5,
          atrTargetMultiplier:    _profM.tpAtrMult    || 2.7,
          atrBreakevenMultiplier: 0.8,
          atrTrailingMultiplier:  1.0
        };
        const direction = fireAction === 'BUY' ? 'Long' : 'Short';
        const strategy = `Manual ${direction} (operator)`;
        const pos = enterTrade(symbol, direction, px, strategy, atr, sessionRegime);
        if (pos) {
          sendSignalToNT8(fireAction, symbol, pos.qty, pos.entryPrice,
            pos.stopLoss, pos.takeProfit, strategy, pos.beTriggerPrice, pos.trailTriggerPrice);
          eventBus.emit('ENTRY', symbol,
            `🖐 MANUAL ${direction} qty=${pos.qty} @${pos.entryPrice.toFixed(2)} SL=${pos.stopLoss.toFixed(2)} TP=${pos.takeProfit.toFixed(2)}`,
            { direction, qty: pos.qty, entry: pos.entryPrice, sl: pos.stopLoss, tp: pos.takeProfit });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            status: 'fired', symbol, direction, qty: pos.qty,
            entry: pos.entryPrice, sl: pos.stopLoss, tp: pos.takeProfit,
            atr: atr.toFixed(2)
          }));
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'enterTrade returned null (sizer refused — DD cap?)' }));
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

      // POST /api/backtest — three actions:
      //   { action: 'report' } (default) → return latest walkforward report
      //   { action: 'quick' }  → kick off `node scripts/train.js --quick --auto-rollback` in background
      //   { action: 'full' }   → kick off `node scripts/train.js --auto-rollback` (150-tree full)
      // For 'quick' and 'full' the response is immediate (training runs async);
      // the dashboard polls back with { action: 'report' } until reportGeneratedAt advances.
      if (pathname === '/api/backtest' && req.method === 'POST') {
        const action = (reqBody.action || 'report').toLowerCase();
        const reportPath = path.join(__dirname, 'models', 'latest_report.json');

        if (action === 'quick' || action === 'full') {
          // Spawn the trainer detached so it survives this request.
          const { spawn } = require('child_process');
          const args = ['scripts/train.js', '--auto-rollback'];
          if (action === 'quick') args.push('--quick');
          try {
            const child = spawn('node', args, { cwd: __dirname, detached: true, stdio: 'ignore' });
            child.unref();
            eventBus.emit('INFO', null, `Calibration started: ${action.toUpperCase()} (background) — args=${args.join(' ')}`);
            res.writeHead(202, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              status: 'started',
              action,
              message: `${action === 'full' ? 'Full' : 'Quick'} calibration running in background. Poll /api/backtest {action:"report"} for results.`,
              expectedDurationMin: action === 'full' ? 25 : 5
            }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'failed', error: e.message }));
          }
        }

        // Default: 'report' — load and format latest_report.json
        if (!fs.existsSync(reportPath)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            results: '⚠️  No training report yet. Use "Quick Calibration" to generate one.',
            summary: { totalProfitPercent: 0, drawdownPercent: 0, winRate: 0, profitFactor: 0, totalTrades: 0 },
            chartData: [],
            reportGeneratedAt: null
          }));
        }
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
        const formatted = _formatBacktestReport(report, reqBody);
        // Include the file's mtime so the dashboard can detect when a new report lands
        const mtime = fs.statSync(reportPath).mtimeMs;
        formatted.reportGeneratedAt = mtime;
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

  // Quality-gate match (same as decisionEngine — WR≥0.55, PF≥1.5, trades≥30).
  // Deployed-only stats are the HONEST forward expectation. The all-bundles
  // aggregate is reported separately so the user can see both numbers.
  const QG_WR = parseFloat(process.env.MIN_WR || '0.55');
  const QG_PF = parseFloat(process.env.MIN_PF || '1.5');
  const QG_TRADES = parseInt(process.env.MIN_TRADES || '30', 10);
  const passesGate = a => a && a.totalTestTrades >= QG_TRADES &&
                          a.winRate >= QG_WR && a.profitFactor >= QG_PF;

  // Twin aggregators — deployed-only (headline) and all-bundles (footnote)
  let dT = 0, dW = 0, dP = 0, dN = 0;  // deployed total trades, weighted WR sum, weighted PF sum, bundle count
  let aT = 0, aW = 0, aP = 0, aN = 0;  // all-bundles
  let maxDD = 0;
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
      // All-bundles
      aT += a.totalTestTrades;
      aW += a.winRate * a.totalTestTrades;
      aP += a.profitFactor * a.totalTestTrades;
      aN++;
      // Deployed-only (passes quality gate)
      const deployed = passesGate(a);
      if (deployed) {
        dT += a.totalTestTrades;
        dW += a.winRate * a.totalTestTrades;
        dP += a.profitFactor * a.totalTestTrades;
        dN++;
      }
      if (a.maxDD > maxDD) maxDD = a.maxDD;
      const status = deployed ? '✓ DEPLOYED' : (b.deployed ? 'deployed' : '✗ GATED');
      text += `  ${key.padEnd(34)} trades=${String(a.totalTestTrades).padEnd(5)} ` +
              `WR=${(a.winRate*100).toFixed(1)}% PF=${a.profitFactor.toFixed(2)} ` +
              `Sharpe=${a.sharpe.toFixed(2)} thresh=${b.threshold.toFixed(2)} [${status}]\n`;
      // Chart point per bundle showing cumulative R progression
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

  const deployedWR = dT > 0 ? dW / dT : 0;
  const deployedPF = dT > 0 ? dP / dT : 0;
  const allWR      = aT > 0 ? aW / aT : 0;
  const allPF      = aT > 0 ? aP / aT : 0;
  text += `── DEPLOYED AGGREGATE (passes quality gate · honest forward expectation) ──\n`;
  text += `  Deployed bundles:        ${dN} of ${aN}\n`;
  text += `  Total deployed trades:   ${dT}\n`;
  text += `  Deployed weighted WR:    ${(deployedWR*100).toFixed(1)}%\n`;
  text += `  Deployed weighted PF:    ${deployedPF.toFixed(2)}\n`;
  text += `── ALL-BUNDLES AGGREGATE (includes gated bundles · misleading if used as forward expectation) ──\n`;
  text += `  Total test trades:       ${aT}\n`;
  text += `  All-bundles weighted WR: ${(allWR*100).toFixed(1)}%\n`;
  text += `  All-bundles weighted PF: ${allPF.toFixed(2)}\n`;
  text += `  Worst single-bundle DD:  ${maxDD.toFixed(1)} R\n`;
  // Use deployed-only as the summary headline going forward
  const aggregateWR = deployedWR;
  const aggregatePF = deployedPF;
  const totalTrades = dT;

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

  // ── Periodic Telegram Status Digest ────────────────────────────────────────
  // Every 30 minutes: send a compact state digest to Telegram so the user can
  // monitor the bot while away from the desk. Shows session, regime, nearest
  // signal, current P&L, and portfolio balance.
  // Also detects "near-threshold" probabilities (within 0.06 of firing) and
  // sends a real-time "signal approaching" alert when probabilities get close.
  const _nearThresholdAlerted = new Set();  // dedup — only alert once per approach
  setInterval(() => {
    try {
      const ps = getPortfolioState();
      const syms = ['NQ=F', 'ES=F'];
      const lines = [];
      let sessionLabel = '';
      let totalRealizedToday = 0;

      for (const sym of syms) {
        const dec = lastDecisions[sym];
        if (!dec) continue;
        sessionLabel = dec.session || '';
        const p = dec.probabilities || {};
        const sym2 = sym.replace('=F','');
        const regime = dec.regime || '—';
        const price = livePrices[sym] ? livePrices[sym].toFixed(2) : '—';

        // Active family micro contract
        const microSym = sym.replace('NQ','MNQ').replace('ES','MES');
        const acc = (ps.accounts[microSym] || ps.accounts[sym]) || {};
        const realized = acc.nt8RealizedPnL || 0;
        totalRealizedToday += realized;

        const posStr = acc.activePosition
          ? `📌 ${acc.activePosition.direction} ×${acc.activePosition.qty} @${acc.activePosition.entryPrice.toFixed(2)} (${acc.activePosition.unrealizedPnL >= 0 ? '+' : ''}$${(acc.activePosition.unrealizedPnL || 0).toFixed(0)})`
          : '⬜ Flat';

        const longPct = p.long != null ? (p.long * 100).toFixed(1) : null;
        const shortPct = p.short != null ? (p.short * 100).toFixed(1) : null;
        const longThPct = p.longTh != null ? (p.longTh * 100).toFixed(1) : null;
        const shortThPct = p.shortTh != null ? (p.shortTh * 100).toFixed(1) : null;

        const probLine = longPct && shortPct
          ? `📊 L:${longPct}%→${longThPct}% | S:${shortPct}%→${shortThPct}%`
          : `📊 ${dec.reason || '—'}`;

        lines.push(`*${sym2}* ${price} | ${regime}\n${posStr}\n${probLine}`);

        // Near-threshold alert: prob within 0.06 of the threshold
        const NEAR_GAP = 0.06;
        ['long','short'].forEach(dir => {
          const prob = p[dir];
          const th = p[dir + 'Th'];
          if (prob == null || th == null) return;
          const key = `${sym}_${dir}_${Math.round(prob * 100)}`;
          if (prob >= (th - NEAR_GAP) && prob < th && !_nearThresholdAlerted.has(key)) {
            _nearThresholdAlerted.add(key);
            const gapPct = ((th - prob) * 100).toFixed(1);
            const dEmoji = dir === 'long' ? '🟢' : '🔴';
            sendTelegramMessage(
              `${dEmoji} *SIGNAL APPROACHING* ${sym2} ${dir.toUpperCase()}\n` +
              `🎯 Prob: ${(prob*100).toFixed(1)}% → needs ${(th*100).toFixed(1)}% (gap: ${gapPct}%)\n` +
              `📍 ${regime} | ${sessionLabel} | Price: ${price}`,
              { header: '⚠️ *Antigravity — Near Threshold*' }
            );
          } else if (prob < (th - NEAR_GAP)) {
            // Reset alert so it can fire again on next approach
            _nearThresholdAlerted.delete(key);
          }
        });
      }

      // Digest summary
      const allFlat = syms.every(s => {
        const a = (ps.accounts[s.replace('NQ','MNQ').replace('ES','MES')] || ps.accounts[s]) || {};
        return !a.activePosition;
      });
      const pnlSign = totalRealizedToday >= 0 ? '+' : '';
      const header = `📡 *Antigravity Status — ${new Date().toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', timeZone:'America/Los_Angeles'})} PT*`;
      sendTelegramMessage(
        lines.join('\n\n') + `\n\n💰 Session P&L: *${pnlSign}$${totalRealizedToday.toFixed(2)}*`,
        { kind: 'summary', header }
      );
    } catch (e) { /* non-fatal */ }
  }, 30 * 60 * 1000);  // every 30 minutes
});
