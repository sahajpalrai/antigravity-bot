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
const TRADING_MODE = (process.env.TRADING_MODE || 'live').toLowerCase(); // always 'live' — NT8 is source of truth

// ── Modules ─────────────────────────────────────────────────────────────────
const { checkTradingStatus, getNextSessionChange, getCurrentSessionState } = require('./lib/scheduleController');
const { getNewsTradingSuspension, fetchEconomicCalendar } = require('./lib/newsCalendar');
const { getYahooFinanceNews } = require('./lib/yahooNews');
const { getActiveSessionRegime } = require('./lib/sessionRegime');
const {
  loadPortfolioState, getPortfolioState, prepareEntry, clearActivePosition,
  transitionToPAAccount,
  setContractMode, getContractMode, activeSymbols,
  ALL_SYMBOLS, MINI_SYMBOLS, MICRO_SYMBOLS, CONTRACT_SPECS,
  familyMiniSymbol, familyMicroSymbol, activeContractFor,
  resetAllAccounts, resetSymbolAccount,
  setFamilyContract, getFamilyContracts,
  setOnPositionClose
} = require('./lib/paperEngine');
const { sendTelegramMessage } = require('./lib/telegram');
const {
  startNT8BridgeServer, sendSignalToNT8, getCandles, setOnBarCallback,
  broadcastBrainState, bootstrapBuffersFromCsv, getLinkedSymbols, isNT8Connected
} = require('./lib/nt8Bridge');
const { decide, modelStatus, getQualityFloors, recordTradeResult, getSafetyState, seedDailyPnLFromNt8 } = require('./lib/decisionEngine');
const { decide2, decide2Shadow } = require('./lib/gate2Engine');
const llmAnalyst = require('./lib/llmAnalyst');

// ── Gate config (hot-reload every 3 seconds) ──────────────────────────────────
const GATE_CONFIG_FILE = path.join(__dirname, 'models', 'gate_config.json');
let _gateCache = null; let _gateCacheMs = 0;
function _getGateConfig() {
  if (_gateCache && (Date.now() - _gateCacheMs) < 3000) return _gateCache;
  try { _gateCache = JSON.parse(fs.readFileSync(GATE_CONFIG_FILE, 'utf-8')); }
  catch (e) { _gateCache = { activeGate: 'gate1', shadowGate2: true }; }
  _gateCacheMs = Date.now();
  return _gateCache;
}
function _setGateConfig(patch) {
  const cfg = _getGateConfig();
  Object.assign(cfg, patch, { updatedAt: new Date().toISOString() });
  fs.writeFileSync(GATE_CONFIG_FILE, JSON.stringify(cfg, null, 2));
  _gateCache = cfg; _gateCacheMs = Date.now();
  return cfg;
}

// ── Per-symbol session trading gate (models/session_trading.json, hot-reload 3s) ──
// {SYM:{RTH:bool,ETH:bool}}. false = symbol won't fire NEW entries that session.
const SESSION_TRADING_FILE = path.join(__dirname, 'models', 'session_trading.json');
let _stCache = null, _stCacheMs = 0;
function _loadSessionTrading() {
  if (_stCache && (Date.now() - _stCacheMs) < 3000) return _stCache;
  try { _stCache = JSON.parse(fs.readFileSync(SESSION_TRADING_FILE, 'utf-8')); }
  catch (e) { _stCache = {}; }
  _stCacheMs = Date.now();
  return _stCache;
}
function _sessionTradingOff(family, session) {
  const st = _loadSessionTrading()[family];
  return !!(st && session && st[session] === false);
}
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


// ── Helper: fire a decision to NT8 (shared by Gate 1 and Gate 2) ─────────────
function _fireToNT8(d, symbol) {
  try {
    const acc     = getPortfolioState().accounts[symbol];
    const linked  = (typeof getLinkedSymbols === 'function') ? getLinkedSymbols() : {};
    const family  = symbol.replace('=F', '').replace(/^M(NQ|ES|CL|GC)$/, '$1');
    const chartSym = linked[family];
    if (!chartSym) {
      eventBus.emit('BLOCKED', symbol, `🚫 LIVE blocked — no NT8 chart for ${family}`);
      return;
    }
    if (chartSym !== symbol) {
      eventBus.emit('BLOCKED', symbol, `🚫 symbol mismatch — bot wants ${symbol} but chart is ${chartSym}`);
      return;
    }
    if (!acc || acc.enabled === false || acc.activePosition || acc.status === 'FAILED') {
      eventBus.emit('BLOCKED', symbol,
        `signal blocked — ${!acc ? 'no account' : acc.enabled === false ? 'symbol OFF' : acc.activePosition ? 'already in position' : 'account FAILED'}`);
      return;
    }
    const direction = d.action === 'BUY' ? 'Long' : 'Short';
    const gateTag   = d.gate === 'gate2' ? `[G2:${d.pattern || 'PAT'}] ` : '';
    const _prof     = getActiveProfile();
    const sessionRegime = {
      ...getActiveSessionRegime(),
      atrStopMultiplier:      _prof.slAtrMult    || 1.5,
      atrTargetMultiplier:    _prof.tpAtrMult    || 2.7,
      atrBreakevenMultiplier: 0.8,
      atrTrailingMultiplier:  2.0
    };
    const strategy = `${gateTag}${d.regime} ${direction} (p=${(d.probability || 0).toFixed(2)})`;
    const pos = prepareEntry(symbol, direction, d.close, strategy, d.atr, sessionRegime);
    if (pos) {
      eventBus.emit('ENTRY', symbol,
        `✓ LIVE ${direction} qty=${pos.qty} @${pos.entryPrice.toFixed(2)} SL=${pos.stopLoss.toFixed(2)} TP=${pos.takeProfit.toFixed(2)}`,
        { direction, qty: pos.qty, entry: pos.entryPrice, sl: pos.stopLoss, tp: pos.takeProfit, gate: d.gate || 'gate1' });
      sendSignalToNT8(d.action, symbol, pos.qty, pos.entryPrice,
        pos.stopLoss, pos.takeProfit, strategy, pos.beTriggerPrice, pos.trailTriggerPrice);
      try {
        const dirEmoji = d.action === 'BUY' ? '🟢' : '🔴';
        const slPts = Math.abs(pos.entryPrice - pos.stopLoss).toFixed(1);
        const tpPts = Math.abs(pos.takeProfit - pos.entryPrice).toFixed(1);
        const gateNote = d.gate === 'gate2' ? ` | 📐 ${d.pattern || 'PATTERN'}` : '';
        sendTelegramMessage(
          `${dirEmoji} *${direction.toUpperCase()}* ${symbol.replace('=F','')} ×${pos.qty}\n` +
          `📍 Entry: \`${pos.entryPrice.toFixed(2)}\`\n` +
          `🛑 SL: \`${pos.stopLoss.toFixed(2)}\` (−${slPts} pts)\n` +
          `🎯 TP: \`${pos.takeProfit.toFixed(2)}\` (+${tpPts} pts)\n` +
          `📊 ${d.regime} | ${d.session}${gateNote}`,
          { kind: 'open', header: `⚡ *Antigravity — Entry*` }
        );
      } catch (e) { /* non-fatal */ }
    } else {
      eventBus.emit('BLOCKED', symbol, 'prepareEntry refused (sizer returned 0)');
    }
  } catch (e) {
    console.error('[_fireToNT8]', e.message);
  }
}

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

  // ── GATE ROUTING ────────────────────────────────────────────────────────────
  // Gate 1 always runs for display (regime events, BRAIN_STATE, dashboard cards).
  // Gate 2 runs async for NT8 firing only when activeGate === 'gate2'.
  // Shadow mode: Gate 2 runs in background and logs what it would have done.
  const gateCfg    = _getGateConfig();
  const activeGate = gateCfg.activeGate || 'gate1';

  // Decision is family-level (uses mini model) — always Gate 1 for display
  const decision = decide(familySym, candles);

  // Shadow mode: run Gate 2 in background, never blocks Gate 1
  if (activeGate === 'gate1' && gateCfg.shadowGate2) {
    decide2Shadow(familySym, candles, decision);
  }

  // Store under BOTH mini and micro keys so dashboard renders consistently
  // regardless of which contract mode is currently selected
  lastDecisions[familySym] = decision;
  if (microSym) lastDecisions[microSym] = decision;

  // LLM prefetch — DISABLED 2026-05-28: gate always returned FLAT (conf=0.00 on
  // 36/40 calls, conf=0.55 downgraded on remaining 4 — zero non-FLAT ever).
  // Was adding ~2.2s latency + continuous API cost with no positive trade contribution.
  // To re-enable: uncomment the block below.
  /*
  try {
    const _fv = (decision && decision.featureSnapshot)
      ? decision.featureSnapshot
      : (decision && decision.liveFeatures ? decision.liveFeatures : null);
    if (_fv) {
      const _gSig = decision.probabilities
        ? { longProb: decision.probabilities.long, shortProb: decision.probabilities.short,
            longTh: decision.probabilities.longTh, shortTh: decision.probabilities.shortTh }
        : null;
      const _regime = decision.regime || lastRegimes[familySym] || 'UNKNOWN';
      llmAnalyst.prefetch(familySym, decision.session || 'ETH', last.time, _fv, candles, _gSig, _regime);
    }
  } catch (_e) { }
  */

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
    const _perAcctMode = 'live';
    // CHOP is tradeable via dedicated CHOP_long/CHOP_short specialists — always
    // send real probs and the specialist name regardless of regime.

    // Compute per-instrument open P&L from price data.
    // NT8's unrealizedPnL is account-wide — all 4 charts on the same sim
    // account share one P&L figure (e.g., ES, CL, GC all show -$9170.50).
    // Fix: derive from (close − entryPrice) × direction × qty × pointVal.
    const _brainSpec = CONTRACT_SPECS[targetSym];
    const _brainPos  = acc.activePosition;
    const _brainPnl  = (() => {
      if (!_brainPos) return 0;
      if (_brainSpec && _brainPos.entryPrice > 0 && last && last.close) {
        const diff = (last.close - _brainPos.entryPrice) * (_brainPos.direction === 'Long' ? 1 : -1);
        return Math.round(diff * (_brainSpec.pointVal || 1) * (_brainPos.qty || 1) * 100) / 100;
      }
      return _brainPos.unrealizedPnL || 0;  // fallback when price unavailable
    })();

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
      longTh:  probs.longTh  !== undefined ? probs.longTh  : null,
      shortTh: probs.shortTh !== undefined ? probs.shortTh : null,
      specialist: (decision && decision.regime && decision.session)
        ? `${familyMiniSymbol(targetSym).replace('=F','')}_${decision.session}_${decision.regime}`
        : '—',
      positionDir: _brainPos ? _brainPos.direction : null,
      positionQty: _brainPos ? _brainPos.qty : 0,
      positionEntry: _brainPos ? _brainPos.entryPrice : 0,
      positionPnl: _brainPnl,
      sl: acc.activePosition ? acc.activePosition.stopLoss : null,
      tp: acc.activePosition ? acc.activePosition.takeProfit : null,
      contractMode: _perFamContract,   // per-family (was global)
      tradingMode: _perAcctMode,       // per-account (was global env)
      exitMode: decision ? decision.exitMode : null,
      gate: activeGate,                // 'gate1' | 'gate2' — shows in Brain Panel
      pattern: (decision && decision.pattern) || null,  // Gate 2 pattern name
      features: topFeatures,
      ts: Date.now()
    });
  } catch (e) {
    console.error('[Server] BRAIN_STATE broadcast failed:', e.message);
  }

  // All symbols are LIVE — decisions go straight to NT8 via the bridge.
  const symbol = targetSym;

  // Gate 2 live: run async pattern engine, fire NT8 with Gate 2 decision instead of Gate 1.
  // Gate 1 (default): fire NT8 with Gate 1 decision synchronously (unchanged behavior).
  if (activeGate === 'gate2') {
    decide2(familySym, candles).then(g2 => {
      if (g2.action === 'BUY' || g2.action === 'SELL') {
        // Use Gate 2 decision for NT8 firing — same logic as Gate 1 path below
        _fireToNT8(g2, symbol, familySym, last);
        eventBus.emit('DECISION', targetSym,
          `[G2] ${g2.action} pattern=${g2.pattern} agree=${g2.agreeingCount} (${g2.regime})`,
          { action: g2.action, pattern: g2.pattern, regime: g2.regime, session: g2.session, gate: 'gate2' });
      }
    }).catch(err => {
      eventBus.emit('INFO', targetSym, `[Gate2] fire error: ${err.message}`);
    });
    return; // Skip Gate 1 NT8 fire below
  }

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
    } else if (_sessionTradingOff(family, decision.session)) {
      eventBus.emit('BLOCKED', symbol, `⏸ ${decision.session} trading is OFF for ${family} (Settings → Session Trading)`);
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
          atrTrailingMultiplier:  2.0
        };
        const strategy = `${decision.regime} ${direction} (p=${decision.probability.toFixed(2)})`;
        const pos = prepareEntry(symbol, direction, decision.close, strategy, decision.atr, sessionRegime);
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
          eventBus.emit('BLOCKED', symbol, 'prepareEntry refused (sizer returned 0)');
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

        // Today's realized P&L per symbol, straight from the daily-loss ledger
        // (mirrors NT8's true realized). This feeds "Today's Performance" so it
        // shows real net even before a per-trade close is recorded — NT8 only
        // streams aggregate P&L, so the per-trade list builds up going forward.
        let dailyRealized = {};
        try {
          const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          const dp = getSafetyState().dailyPnL || {};
          for (const k of Object.keys(dp)) {
            if (dp[k] && dp[k].date === todayET && Math.abs(dp[k].pnl || 0) > 0.001) {
              dailyRealized[k] = +(dp[k].pnl).toFixed(2);
            }
          }
        } catch (e) { /* non-fatal */ }

        // Exhaustion-guard state (which symbols' TREND_UP shorts are guarded) — drives
        // the per-symbol guard checkboxes in Settings.
        let exhaustGuard = { enabled: false, symbols: ['ES'] };
        try {
          const eg = JSON.parse(fs.readFileSync(path.join(__dirname, 'models', 'exhaust_guard.json'), 'utf-8'));
          exhaustGuard = { enabled: !!eg.enabled, symbols: Array.isArray(eg.symbols) ? eg.symbols : ['ES'] };
        } catch (e) { /* non-fatal */ }

        let stopCap = { enabled: false, maxDollar: 900 };
        try {
          const sc = JSON.parse(fs.readFileSync(path.join(__dirname, 'models', 'stop_cap.json'), 'utf-8'));
          stopCap = { enabled: !!sc.enabled, maxDollar: sc.maxDollar || 900 };
        } catch (e) { /* non-fatal */ }

        return res.end(JSON.stringify({
          ...portfolioState,
          dailyRealized,
          exhaustGuard,
          stopCap,
          sessionTrading: _loadSessionTrading(),
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
          familyContracts: (typeof getFamilyContracts === 'function') ? getFamilyContracts() : {},
          tastytradeId: process.env.TASTYTRADE_CLIENT_ID,
          llmAnalyst: llmAnalyst.getStatus(),
          activeGate: _getGateConfig().activeGate || 'gate1',
          shadowGate2: !!_getGateConfig().shadowGate2,
          nt8Connected: isNT8Connected()
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

      // GET /api/llm-status — LLM analyst state (per-symbol cached signals)
      if (pathname === '/api/llm-status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(llmAnalyst.getStatus()));
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

      // GET /api/gate — return active gate config
      if (pathname === '/api/gate' && req.method === 'GET') {
        const cfg = _getGateConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          activeGate:  cfg.activeGate  || 'gate1',
          shadowGate2: !!cfg.shadowGate2
        }));
      }

      // POST /api/gate — switch active gate or toggle shadow mode
      // body: { activeGate: 'gate1' | 'gate2' } or { shadowGate2: true | false }
      // or both fields together
      if (pathname === '/api/gate' && req.method === 'POST') {
        const patch = {};
        if (reqBody.activeGate && ['gate1', 'gate2'].includes(reqBody.activeGate)) {
          patch.activeGate = reqBody.activeGate;
        }
        if (reqBody.shadowGate2 !== undefined) {
          patch.shadowGate2 = !!reqBody.shadowGate2;
        }
        if (Object.keys(patch).length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'body must include activeGate (gate1|gate2) or shadowGate2 (bool)' }));
        }
        _setGateConfig(patch);
        const cfg = _getGateConfig();
        if (patch.activeGate) {
          eventBus.emit('INFO', null, `Signal engine → ${cfg.activeGate.toUpperCase()} ${cfg.shadowGate2 ? '(shadow ON)' : ''}`);
        }
        if (patch.shadowGate2 !== undefined) {
          eventBus.emit('INFO', null, `Gate 2 shadow mode → ${cfg.shadowGate2 ? 'ON' : 'OFF'}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          status:      'success',
          activeGate:  cfg.activeGate,
          shadowGate2: cfg.shadowGate2
        }));
      }

      // POST /api/exhaust-guard — toggle the TREND_UP short exhaustion guard for a
      // symbol (add/remove from models/exhaust_guard.json symbols[]). Hot-reloads.
      // Body: { symbol: 'NQ'|'ES'|..., enabled: true|false }
      if (pathname === '/api/exhaust-guard' && req.method === 'POST') {
        const sym = (reqBody.symbol || '').replace('=F', '').toUpperCase();
        const enabled = !!reqBody.enabled;
        const gf = path.join(__dirname, 'models', 'exhaust_guard.json');
        let ok = false, symbols = ['ES'];
        try {
          const eg = JSON.parse(fs.readFileSync(gf, 'utf-8'));
          symbols = Array.isArray(eg.symbols) ? eg.symbols : ['ES'];
          if (sym) {
            const has = symbols.includes(sym);
            if (enabled && !has) symbols.push(sym);
            if (!enabled && has) symbols = symbols.filter(s => s !== sym);
            eg.symbols = symbols;
            fs.writeFileSync(gf, JSON.stringify(eg, null, 2));
            ok = true;
            eventBus.emit('INFO', null, `Exhaustion guard ${sym} TREND_UP shorts → ${enabled ? 'ON (guarded)' : 'OFF (raw)'}`);
          }
        } catch (e) { /* non-fatal */ }
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: ok ? 'success' : 'failed', symbol: sym, enabled, symbols }));
      }

      // POST /api/stop-cap — toggle / set the per-trade dollar-risk stop cap.
      // Body: { enabled: true|false, maxDollar?: <number> }. Hot-reloads (≤10s).
      if (pathname === '/api/stop-cap' && req.method === 'POST') {
        const cf = path.join(__dirname, 'models', 'stop_cap.json');
        let ok = false, cfg = { enabled: false, maxDollar: 900 };
        try {
          try { cfg = JSON.parse(fs.readFileSync(cf, 'utf-8')); } catch (e) {}
          if (typeof reqBody.enabled === 'boolean') cfg.enabled = reqBody.enabled;
          if (reqBody.maxDollar != null && +reqBody.maxDollar > 0) cfg.maxDollar = +reqBody.maxDollar;
          fs.writeFileSync(cf, JSON.stringify(cfg, null, 2));
          ok = true;
          eventBus.emit('INFO', null, `Stop cap → ${cfg.enabled ? 'ON $' + cfg.maxDollar + '/contract' : 'OFF (raw ATR stops)'}`);
        } catch (e) { /* non-fatal */ }
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: ok ? 'success' : 'failed', stopCap: cfg }));
      }

      // POST /api/session-trading — per-symbol RTH/ETH on/off.
      // Body: { symbol: 'NQ', session: 'RTH'|'ETH', enabled: true|false }. Hot-reloads.
      if (pathname === '/api/session-trading' && req.method === 'POST') {
        const sym = (reqBody.symbol || '').replace('=F', '').toUpperCase();
        const sess = (reqBody.session || '').toUpperCase();
        const enabled = !!reqBody.enabled;
        let ok = false, cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(SESSION_TRADING_FILE, 'utf-8')); } catch (e) {}
        if (sym && (sess === 'RTH' || sess === 'ETH')) {
          if (!cfg[sym] || typeof cfg[sym] !== 'object') cfg[sym] = { RTH: true, ETH: true };
          cfg[sym][sess] = enabled;
          try {
            fs.writeFileSync(SESSION_TRADING_FILE, JSON.stringify(cfg, null, 2));
            _stCache = null;  // force reload
            ok = true;
            eventBus.emit('INFO', null, `${sym} ${sess} trading → ${enabled ? 'ON' : 'OFF'}`);
          } catch (e) { /* non-fatal */ }
        }
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: ok ? 'success' : 'failed', sessionTrading: cfg }));
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

      // GET /api/shadow-log — Gate 2 shadow mode summary
      // Returns the last 200 entries from gate2/shadow_log.json with
      // a summary: total bars, G2 fires, agreement rate, pattern breakdown.
      if (pathname === '/api/shadow-log' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        try {
          const logFile = path.join(__dirname, 'gate2', 'shadow_log.json');
          let rows = [];
          if (fs.existsSync(logFile)) {
            const raw = fs.readFileSync(logFile, 'utf-8').trim();
            if (raw) rows = JSON.parse(raw);
          }
          // Most recent first, cap at 200 for display
          const recent = rows.slice(-200).reverse();
          // Compute summary stats
          const total = rows.length;
          let gate2Fires = 0, agreements = 0, eligiblePairs = 0;
          const patternCounts = {};
          for (const r of rows) {
            if (r.gate2Signal && r.gate2Signal !== 'FLAT') gate2Fires++;
            if (r.gate2Pattern) patternCounts[r.gate2Pattern] = (patternCounts[r.gate2Pattern] || 0) + 1;
            if (r.agrees !== null && r.agrees !== undefined) {
              eligiblePairs++;
              if (r.agrees) agreements++;
            }
          }
          return res.end(JSON.stringify({
            rows: recent,
            summary: {
              total,
              gate2Fires,
              agreementRate: eligiblePairs > 0 ? agreements / eligiblePairs : null,
              patternCounts
            }
          }));
        } catch (e) {
          return res.end(JSON.stringify({ rows: [], summary: { total: 0, gate2Fires: 0, agreementRate: null, patternCounts: {} }, error: e.message }));
        }
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
          // Wipe loss-attribution buckets
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
          return res.end(JSON.stringify({ error: 'already in position — use FLAT first' }));
        }
        const px = livePrices[symbol] || livePrices[familyMiniSymbol(symbol)];
        if (!px) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'no live price yet — NT8 not streaming?' }));
        }
        // ── NT8 connection gate ─────────────────────────────────────────────
        // All accounts are live — block manual fire if NT8 not connected.
        if (!isNT8Connected()) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: 'NT8 not connected — open AntigravityBotBridge in NinjaTrader and wait for the bridge to connect, then retry'
          }));
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
          atrTrailingMultiplier:  2.0
        };
        const direction = fireAction === 'BUY' ? 'Long' : 'Short';
        const strategy = `Manual ${direction} (operator)`;
        const pos = prepareEntry(symbol, direction, px, strategy, atr, sessionRegime); // use sizer -> honors userMaxContracts
        if (pos) {
          // Pre-send STATUS 1 so NT8's isTradingEnabled is guaranteed true
          // before the trade signal arrives — handles the case where a prior
          // STOP or symbol-OFF sent STATUS 0 and the re-enable wasn't received.
          sendSignalToNT8('STATUS', symbol, 1, 0, 0, 0);
          sendSignalToNT8(fireAction, symbol, pos.qty, pos.entryPrice,
            pos.stopLoss, pos.takeProfit, strategy, pos.beTriggerPrice, pos.trailTriggerPrice);
          eventBus.emit('ENTRY', symbol,
            `🖐 MANUAL ${direction} qty=${pos.qty} @${pos.entryPrice.toFixed(2)} SL=${pos.stopLoss.toFixed(2)} TP=${pos.takeProfit.toFixed(2)}`,
            { direction, qty: pos.qty, entry: pos.entryPrice, sl: pos.stopLoss, tp: pos.takeProfit });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            status: 'fired', symbol, direction, qty: pos.qty,
            entry: pos.entryPrice, sl: pos.stopLoss, tp: pos.takeProfit,
            atr: atr.toFixed(2), nt8Sent: true
          }));
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `prepareEntry refused — symbol is disabled or already in a position (symbol=${symbol}, enabled=${acc.enabled})` }));
      }

      // POST /api/close — force close a symbol's position
      if (pathname === '/api/close' && req.method === 'POST') {
        const { symbol } = reqBody;
        const ps = getPortfolioState();
        const acc = ps.accounts[symbol];
        if (acc && acc.activePosition) {
          // Snapshot position BEFORE clearing so Telegram has the details.
          // clearActivePosition() wipes the record immediately (dashboard → Flat),
          // but NT8 METRICS Flat won't fire the setOnPositionClose callback because
          // prevPosition will already be null by the time it arrives.
          const closedPos = { ...acc.activePosition };
          clearActivePosition(symbol);
          if (isNT8Connected()) {
            sendSignalToNT8('CLOSE', symbol, 0, 0, 0, 0);
          } else {
            eventBus.emit('WARN', symbol, `⚠ FLAT sent but NT8 not connected — close the position manually in NT8`);
          }
          eventBus.emit('CLOSE', symbol, '🖐 Forced close via dashboard', { pnl: 0 });
          // Send Telegram close alert (P&L unknown at this point — NT8 hasn't confirmed yet)
          try {
            const dir = closedPos.direction || '?';
            const entry = closedPos.entryPrice ? closedPos.entryPrice.toFixed(2) : '?';
            const strategy = closedPos.strategyUsed || '?';
            sendTelegramMessage(
              `🖐 *MANUAL CLOSE* ${symbol.replace('=F','')} ${dir.toUpperCase()} ×${closedPos.qty || 1}\n` +
              `📍 Entry: \`${entry}\`\n` +
              `🔖 ${strategy}\n` +
              `💵 P&L pending NT8 confirm`,
              { kind: 'close', header: '🖐 *Antigravity — Forced Close*' }
            );
          } catch (e) { /* non-fatal */ }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            status: 'success',
            nt8Sent: isNT8Connected()
          }));
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

      // POST /api/mode — change account mode (+ optional firmType + drawdownAmount)
      if (pathname === '/api/mode' && req.method === 'POST') {
        const { changeAccountMode } = require('./lib/paperEngine');
        const success = changeAccountMode(reqBody.symbol, reqBody.mode, reqBody.firmType, reqBody.drawdownAmount);
        res.writeHead(success ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: success ? 'success' : 'failed' }));
      }

      // POST /api/firm-type — switch APEX ↔ EOD without resetting balances
      if (pathname === '/api/firm-type' && req.method === 'POST') {
        const { setFirmType } = require('./lib/paperEngine');
        const result = setFirmType(reqBody.symbol, reqBody.firmType);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      }

      // POST /api/drawdown-amount — update per-account trailing DD limit
      if (pathname === '/api/drawdown-amount' && req.method === 'POST') {
        const { setDrawdownAmount } = require('./lib/paperEngine');
        const result = setDrawdownAmount(reqBody.symbol, reqBody.amount);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      }

      // POST /api/max-contracts — set per-account max-contracts ceiling
      // Body: { symbol: "MNQ=F", qty: 3 }
      if (pathname === '/api/max-contracts' && req.method === 'POST') {
        const { setUserMaxContracts } = require('./lib/paperEngine');
        const result = setUserMaxContracts(reqBody.symbol, reqBody.qty);
        if (result.ok) {
          eventBus.emit('INFO', reqBody.symbol, `Max contracts → ${result.userMaxContracts} for ${reqBody.symbol}`);
        }
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
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
          settings: _legacySettingsShim()
        }));
      }

      // GET /api/models — list trained model bundles + their walkforward metrics
      if (pathname === '/api/models' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ models: modelStatus() }));
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

// ── EOD force-close timer ────────────────────────────────────────────────────
// Fires every 30s. Between 4:58–5:05 PM ET (1:58–2:05 PM PT), sends CLOSE for
// any open position so nothing survives into the CME maintenance window.
// A per-day latch (_eodClosedToday) prevents spamming repeated CLOSE signals.
let _eodClosedToday = '';
setInterval(() => {
  const now    = new Date();
  const month  = now.getUTCMonth();
  const offset = (month >= 2 && month <= 10) ? 4 : 5;  // EDT or EST
  const etH    = (now.getUTCHours() - offset + 24) % 24;
  const etM    = now.getUTCMinutes();
  const etTotal = etH * 60 + etM;
  const todayKey = now.toISOString().slice(0, 10);
  // Fire window: 4:58 PM – 5:05 PM ET
  if (etTotal < 16 * 60 + 58 || etTotal >= 17 * 60 + 5) return;
  if (_eodClosedToday === todayKey) return;  // already ran today
  _eodClosedToday = todayKey;
  const ps = getPortfolioState();
  const symbols = Object.keys(ps.accounts);
  let closedAny = false;
  symbols.forEach(sym => {
    const acc = ps.accounts[sym];
    if (acc && acc.activePosition) {
      console.log(`[EOD] Force-closing ${sym} @ 4:58 PM ET (${etH}:${String(etM).padStart(2,'0')} ET)`);
      sendSignalToNT8('CLOSE', sym, 0, 0, 0, 0);
      closedAny = true;
    }
  });
  if (closedAny) {
    sendTelegramMessage(`🛑 *EOD Force-Close* triggered at 4:58 PM ET — all positions closed before CME maintenance.`);
    eventBus.emit('EOD_CLOSE', 'ALL', 'EOD force-close at 4:58 PM ET — CME maintenance in 2 min', {});
  } else {
    console.log(`[EOD] 4:58 PM ET check — no open positions, nothing to close.`);
  }
}, 30000);

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
