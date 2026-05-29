const fs = require('fs');
const path = require('path');
const { sendTelegramMessage } = require('./telegram');

const PERSIST_FILE_PATH = path.join(__dirname, '../portfolio_state.json');

const INITIAL_BALANCE = 50000;
const DRAWDOWN_LIMIT = 2500;   // Default — overridden per-account via acc.drawdownAmount
const PROFIT_TARGET = 3000;    // Pass at $53,000

// Per-account drawdown amount (user can set each account independently).
// Defaults to the global DRAWDOWN_LIMIT when not explicitly set.
function _getDrawdownAmount(acc) {
  return (typeof acc.drawdownAmount === 'number' && acc.drawdownAmount > 0)
    ? acc.drawdownAmount
    : DRAWDOWN_LIMIT;
}

// Update peak equity and drawdown floor for a given account.
//
//   firmType === 'APEX'  (default):
//     APEX Evaluation / PA — trailing drawdown follows INTRADAY equity including
//     unrealized P&L. A +$500 open position permanently consumes $500 of drawdown
//     room even if you exit flat. Industry standard for APEX prop accounts.
//
//   firmType === 'EOD' (TopStep / Tradeovate / similar):
//     Floor ONLY advances when the account is FLAT (activePosition===null) and
//     realized balance > previous peak. Intraday unrealized P&L never moves the
//     floor. Classic end-of-day trailing drawdown — TopStep Combine/Funded standard.
//
// isFlat: true when activePosition === null (caller must pass this in).
function _updatePeakAndFloor(acc, totalEquity, isFlat) {
  const ddAmt   = _getDrawdownAmount(acc);
  const firm    = acc.firmType || 'APEX';
  const isPA    = acc.mode === 'PA';

  if (firm === 'EOD') {
    // TopStep-style: only advance floor on FLAT account with improved balance
    if (isFlat && totalEquity > acc.peakEquity) {
      acc.peakEquity    = totalEquity;
      // PA/Funded: floor never retreats — it only moves up from where it started
      acc.drawdownFloor = isPA
        ? Math.max(acc.drawdownFloor, acc.peakEquity - ddAmt)
        : acc.peakEquity - ddAmt;
    }
  } else {
    // APEX default: intraday equity (balance + unrealized) moves the floor
    if (totalEquity > acc.peakEquity) {
      acc.peakEquity = totalEquity;
      if (isPA) {
        // APEX PA: floor locks once it would rise above $50,100 (industry floor lock)
        acc.drawdownFloor = Math.min(INITIAL_BALANCE + 100, acc.peakEquity - ddAmt);
      } else {
        acc.drawdownFloor = acc.peakEquity - ddAmt;
      }
    }
  }
}

// Future Symbol Contract Settings
// Notional values cross-checked against CME spec sheets:
//   NQ:  $20 per index point     (1 tick = 0.25 idx pts = $5.00)
//   MNQ: $2  per index point     (1 tick = 0.25 idx pts = $0.50)   — 1/10 mini
//   ES:  $50 per index point     (1 tick = 0.25 idx pts = $12.50)
//   MES: $5  per index point     (1 tick = 0.25 idx pts = $1.25)   — 1/10 mini
//   CL:  $1000 per dollar move   (1 tick = $0.01 = $10.00)
//   MCL: $100  per dollar move   (1 tick = $0.01 = $1.00)          — 1/10 mini
//   GC:  $100 per dollar move    (1 tick = $0.10 = $10.00)
//   MGC: $10  per dollar move    (1 tick = $0.10 = $1.00)          — 1/10 mini
// maxContracts: minis capped at 2 (APX rule); micros allow 10× since each
// micro risks 1/10 of a mini per tick — keeps proportional exposure.
const CONTRACT_SPECS = {
  // ── Minis ──
  'NQ=F':  { name: 'E-mini Nasdaq-100',  tickSize: 0.25, tickVal:  5.00, pointVal:   20.00, commRound: 4.00, maxContracts:  2, family: 'NQ', isMicro: false },
  'ES=F':  { name: 'E-mini S&P 500',     tickSize: 0.25, tickVal: 12.50, pointVal:   50.00, commRound: 4.00, maxContracts:  2, family: 'ES', isMicro: false },
  'CL=F':  { name: 'Crude Oil',          tickSize: 0.01, tickVal: 10.00, pointVal: 1000.00, commRound: 4.00, maxContracts:  2, family: 'CL', isMicro: false },
  'GC=F':  { name: 'Gold',               tickSize: 0.10, tickVal: 10.00, pointVal:  100.00, commRound: 4.00, maxContracts:  2, family: 'GC', isMicro: false },
  // ── Micros (1/10 of mini notional) ──
  'MNQ=F': { name: 'Micro E-mini Nasdaq', tickSize: 0.25, tickVal: 0.50, pointVal:    2.00, commRound: 1.40, maxContracts: 20, family: 'NQ', isMicro: true,  miniSymbol: 'NQ=F' },
  'MES=F': { name: 'Micro E-mini S&P',    tickSize: 0.25, tickVal: 1.25, pointVal:    5.00, commRound: 1.40, maxContracts: 20, family: 'ES', isMicro: true,  miniSymbol: 'ES=F' },
  'MCL=F': { name: 'Micro Crude Oil',     tickSize: 0.01, tickVal: 1.00, pointVal:  100.00, commRound: 1.40, maxContracts: 20, family: 'CL', isMicro: true,  miniSymbol: 'CL=F' },
  'MGC=F': { name: 'Micro Gold',          tickSize: 0.10, tickVal: 1.00, pointVal:   10.00, commRound: 1.40, maxContracts: 20, family: 'GC', isMicro: true,  miniSymbol: 'GC=F' }
};

const FAMILIES = ['NQ', 'ES', 'CL', 'GC'];
const MINI_SYMBOLS  = ['NQ=F',  'ES=F',  'CL=F',  'GC=F'];
const MICRO_SYMBOLS = ['MNQ=F', 'MES=F', 'MCL=F', 'MGC=F'];
const ALL_SYMBOLS   = [...MINI_SYMBOLS, ...MICRO_SYMBOLS];

// Returns the mini equivalent symbol for any contract (used when looking up
// trained model files — micros piggyback on mini models since the underlying
// price action is identical).
function familyMiniSymbol(symbol) {
  const spec = CONTRACT_SPECS[symbol];
  if (!spec) return symbol;
  return spec.isMicro ? spec.miniSymbol : symbol;
}

// Returns the micro counterpart for any contract (used to mirror prices and
// route entries when contract mode is MICRO).
function familyMicroSymbol(symbol) {
  const spec = CONTRACT_SPECS[symbol];
  if (!spec) return null;
  if (spec.isMicro) return symbol;
  return MICRO_SYMBOLS.find(s => CONTRACT_SPECS[s].family === spec.family) || null;
}

// Returns the active contract for a family, using per-family preference
// (falls back to global contractMode for backwards compat).
// Example: family='NQ', familyContract.NQ='MICRO' → 'MNQ=F'
function activeContractFor(symbolOrFamily) {
  let family;
  if (CONTRACT_SPECS[symbolOrFamily]) {
    family = CONTRACT_SPECS[symbolOrFamily].family;
  } else if (FAMILIES.includes(symbolOrFamily)) {
    family = symbolOrFamily;
  } else {
    return null;
  }
  // Per-family preference wins; fall back to global contractMode if unset.
  const perFamily = (portfolio.familyContract || {})[family];
  const mode = perFamily || portfolio.contractMode || 'MINI';
  const targetList = mode === 'MICRO' ? MICRO_SYMBOLS : MINI_SYMBOLS;
  return targetList.find(s => CONTRACT_SPECS[s].family === family) || null;
}

// Per-family contract setter. Updates one family without touching others.
function setFamilyContract(family, type) {
  if (!FAMILIES.includes(family)) return { ok: false, error: 'unknown family' };
  const t = String(type || '').toUpperCase();
  if (t !== 'MINI' && t !== 'MICRO') return { ok: false, error: 'type must be MINI or MICRO' };
  if (!portfolio.familyContract) portfolio.familyContract = {};
  portfolio.familyContract[family] = t;
  savePortfolioState();
  return { ok: true, family, type: t };
}

// Returns the per-family contract map (with defaults)
function getFamilyContracts() {
  const out = {};
  const defaultMode = portfolio.contractMode || 'MINI';
  for (const f of FAMILIES) {
    out[f] = (portfolio.familyContract || {})[f] || defaultMode;
  }
  return out;
}

// Default account number scheme. APX accounts can be named freely by the user.
function defaultAccountNumber(symbol) {
  const spec = CONTRACT_SPECS[symbol];
  if (!spec) return symbol;
  const sizeLabel = spec.isMicro ? '25K' : '50K';
  const cleanSym = symbol.replace('=F', '');
  return `APX-${cleanSym}-${sizeLabel}`;
}

function _buildDefaultAccount(symbol) {
  return {
    balance: INITIAL_BALANCE,
    peakEquity: INITIAL_BALANCE,
    drawdownFloor: INITIAL_BALANCE - DRAWDOWN_LIMIT,
    activePosition: null,
    status: 'Active',
    passed: false,
    mode: 'Evaluation',
    // firmType determines HOW the trailing drawdown floor is tracked:
    //   'APEX'  — intraday trailing (unrealized P&L moves floor immediately)
    //   'EOD'   — end-of-day trailing (floor only advances on flat realized gains)
    // Default is 'APEX'. Set to 'EOD' for TopStep / Tradeovate / similar firms.
    firmType: 'APEX',
    // drawdownAmount: per-account override for maximum trailing drawdown.
    // Defaults to the global DRAWDOWN_LIMIT ($2,500) when not set.
    // Common values: 1500 (micro), 2500 (standard 50K), 3000/4500 (funded).
    drawdownAmount: DRAWDOWN_LIMIT,
    accountNumber: defaultAccountNumber(symbol),
    enabled: true,
    // Per-account trading mode toggle. 'live' = NT8 is source-of-truth for
    // P&L and position state; 'paper' = internal simulation only.
    // Changed 2026-05-28: default is now 'live'. NT8 charts for NQ/ES/MNQ/MES
    // are already connected. CL/GC families are disabled (no NT8 chart) until
    // the user opens a chart and enables them manually.
    tradingMode: 'live'
  };
}

// Per-symbol live/paper toggle — flips one account's mode without affecting others
function setAccountTradingMode(symbol, mode) {
  const acc = portfolio.accounts[symbol];
  if (!acc) return { ok: false, error: 'unknown symbol' };
  const m = String(mode || '').toLowerCase();
  if (m !== 'live' && m !== 'paper') return { ok: false, error: 'mode must be live or paper' };
  acc.tradingMode = m;
  savePortfolioState();
  return { ok: true, symbol, mode: m };
}

// Per-symbol reset — wipe one account back to fresh $50K balance + clear
// its history, BUT preserve every user-customized field so the reset only
// wipes the financial state, not the user's config.
function resetSymbolAccount(symbol) {
  if (!portfolio.accounts[symbol]) return { ok: false, error: 'unknown symbol' };
  const old = portfolio.accounts[symbol];
  // Capture every field the user might have customized
  const preserved = {
    tradingMode:   old.tradingMode,
    accountNumber: old.accountNumber,
    enabled:       old.enabled,
    mode:          old.mode,           // 'Evaluation' / 'PA' / 'Standard'
    passed:        old.passed,
    // Preserve NT8 sync fields so the dashboard doesn't briefly show wrong
    // balance until NT8 re-pushes a METRICS message.
    lastNt8Update:     old.lastNt8Update,
    nt8Balance:        old.nt8Balance,
    nt8RealizedPnL:    old.nt8RealizedPnL,
    nt8UnrealizedPnL:  old.nt8UnrealizedPnL
  };
  portfolio.accounts[symbol] = _buildDefaultAccount(symbol);
  // Re-apply preserved fields (only when they were actually set)
  for (const k of Object.keys(preserved)) {
    if (preserved[k] !== undefined) portfolio.accounts[symbol][k] = preserved[k];
  }
  // Wipe paper trades for this symbol
  try {
    const PAPER_FILE = path.join(__dirname, '..', 'models', 'paper_trades.json');
    if (fs.existsSync(PAPER_FILE)) {
      const data = JSON.parse(fs.readFileSync(PAPER_FILE, 'utf-8'));
      data.trades = (data.trades || []).filter(t => t.symbol !== symbol);
      if (data.openPositions) data.openPositions[symbol] = null;
      fs.writeFileSync(PAPER_FILE, JSON.stringify(data, null, 2));
    }
  } catch (e) { /* non-fatal */ }
  // Wipe history entries for this symbol
  portfolio.history = (portfolio.history || []).filter(h => h.symbol !== symbol);
  savePortfolioState();
  return { ok: true, symbol };
}

let portfolio = {
  contractMode: 'MINI',  // 'MINI' | 'MICRO' — global toggle for which family fires
  accounts: {},
  history: []
};
// Initialize all 8 contract accounts
for (const sym of ALL_SYMBOLS) portfolio.accounts[sym] = _buildDefaultAccount(sym);

// Load saved state if it exists. Schema-tolerant: fills in any missing fields
// from the new 8-contract default so existing portfolio_state.json files keep
// working after the Micros upgrade.
function loadPortfolioState() {
  if (!fs.existsSync(PERSIST_FILE_PATH)) {
    console.log('[PaperEngine] No saved state — using fresh defaults (8 contracts).');
    return;
  }
  try {
    const saved = JSON.parse(fs.readFileSync(PERSIST_FILE_PATH, 'utf-8'));
    if (!saved.accounts) {
      console.warn('[PaperEngine] Saved state has no accounts — using defaults.');
      return;
    }

    // Default contract mode (older files won't have this field)
    portfolio.contractMode = saved.contractMode || 'MINI';

    // Merge each saved account onto its default; add missing contracts
    for (const sym of ALL_SYMBOLS) {
      const defaults = _buildDefaultAccount(sym);
      const savedAcc = saved.accounts[sym];
      portfolio.accounts[sym] = savedAcc
        ? { ...defaults, ...savedAcc }
        : defaults;
      // Backfill any keys that were added after the saved file was written
      const a = portfolio.accounts[sym];
      if (a.enabled === undefined)       a.enabled       = true;
      if (!a.accountNumber)              a.accountNumber = defaultAccountNumber(sym);
      if (!a.firmType)                   a.firmType      = 'APEX';  // legacy accounts default to APEX
      if (typeof a.drawdownAmount !== 'number') a.drawdownAmount = DRAWDOWN_LIMIT;
    }

    portfolio.history = saved.history || [];
    console.log(`[PaperEngine] Loaded portfolio state — mode=${portfolio.contractMode}, ${Object.keys(portfolio.accounts).length} accounts.`);
  } catch (e) {
    console.error('[PaperEngine] Failed to load portfolio state:', e.message, '— using defaults.');
  }
}

// Returns the currently active symbol per family — respects per-family
// contract preference so user can mix mini + micro across families.
function activeSymbols() {
  return FAMILIES.map(f => activeContractFor(f)).filter(Boolean);
}

// Hard reset: wipes all 8 accounts back to fresh $50K state and clears history.
// Used when starting a brand-new paper run and you want zero legacy data
// bleeding through (test contamination, inflated peak equity, stale P&L).
function resetAllAccounts() {
  portfolio.accounts = {};
  for (const sym of ALL_SYMBOLS) portfolio.accounts[sym] = _buildDefaultAccount(sym);
  portfolio.history = [];
  // Preserve contractMode — that's a preference, not state to wipe
  savePortfolioState();
  return true;
}

// Reset just ONE symbol's account (preserves the other 7 + history)
// (resetSymbolAccount defined earlier — the new version clears paper
//  trades + history + preserves user-set tradingMode/accountNumber.)

// Toggles contract mode globally. Only applies to NEW entries — existing
// open positions stay on whatever contract they were opened with.
function setContractMode(mode) {
  if (mode !== 'MINI' && mode !== 'MICRO') return false;
  portfolio.contractMode = mode;
  savePortfolioState();
  return true;
}

function getContractMode() {
  return portfolio.contractMode || 'MINI';
}

function savePortfolioState() {
  // Atomic write: write to a temp file first, then rename — prevents partial-read
  // corruption if the process is interrupted mid-write (common on Windows).
  const tmpPath = PERSIST_FILE_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(portfolio, null, 2), 'utf-8');
  fs.renameSync(tmpPath, PERSIST_FILE_PATH);
}

// Get portfolio overview
function getPortfolioState() {
  let totalBalance = 0;
  let totalOpenPnL = 0;

  // Aggregate realized profit/loss by symbol from trade history
  const realizedPnLBySymbol = {};
  for (const sym of Object.keys(portfolio.accounts)) {
    realizedPnLBySymbol[sym] = 0;
  }
  
  if (portfolio.history) {
    for (const trade of portfolio.history) {
      if (realizedPnLBySymbol[trade.symbol] !== undefined) {
        realizedPnLBySymbol[trade.symbol] += trade.profit;
      }
    }
  }

  // Calculate live values
  const enrichedAccounts = {};
  for (const sym of Object.keys(portfolio.accounts)) {
    const acc = portfolio.accounts[sym];
    const spec = CONTRACT_SPECS[sym];
    
    // Check if NT8 connection is active (e.g. received update in the last 5 minutes)
    const isNT8Active = acc.lastNt8Update && (Date.now() - acc.lastNt8Update < 300000);
    
    const balance = isNT8Active ? acc.nt8Balance : acc.balance;
    const unrealizedPnL = isNT8Active ? acc.nt8UnrealizedPnL : (acc.activePosition ? acc.activePosition.unrealizedPnL : 0);
    const realizedPnL = isNT8Active ? acc.nt8RealizedPnL : (realizedPnLBySymbol[sym] || 0);

    totalBalance += balance;
    totalOpenPnL += unrealizedPnL;

    // PHANTOM-POSITION BUG FIX (2026-05-26):
    // We used to synthesize an activePosition from sign(unrealizedPnL)
    // when NT8 was active. That's wrong — NT8 reports drift mid-bar even
    // when truly Flat (e.g., during bracket fill races), producing a
    // phantom Long×N @ 0 on the dashboard.
    //
    // Trust the activePosition that updateLiveMetricsFromNT8() already
    // set from NT8's authoritative positionInfo (marketPosition field).
    // Only override the cached unrealizedPnL with fresh value from this
    // METRICS message.
    let activePosition = acc.activePosition;
    if (isNT8Active && activePosition) {
      activePosition = { ...activePosition, unrealizedPnL };
    }

    enrichedAccounts[sym] = {
      ...acc,
      balance,
      realizedPnL,
      unrealizedPnL,
      totalPnL: realizedPnL + unrealizedPnL,
      activePosition,
      isNT8Connected: isNT8Active
    };
  }

  return {
    ...portfolio,
    accounts: enrichedAccounts,
    totalBalance,
    totalEquity: totalBalance + totalOpenPnL,
    totalOpenPnL
  };
}

// DD-aware position sizer: caps risk per trade to a fraction of remaining
// distance to the drawdown floor (Prop mode) or a fixed % of balance (Standard).
// Returns an integer quantity in [1, spec.maxContracts].
function _sizePosition(acc, spec, stopDistance, direction) {
  // Risk-per-trade: 25% of remaining DD room for Prop accounts; 1% balance for Standard
  const dollarStopPerContract = stopDistance * spec.pointVal;
  if (dollarStopPerContract <= 0) return 1;

  let dollarRiskBudget;
  if (acc.mode === 'Standard') {
    dollarRiskBudget = acc.balance * 0.01;
  } else {
    const remainingDD = Math.max(0, acc.balance - acc.drawdownFloor);
    dollarRiskBudget = remainingDD * 0.25;
  }

  if (dollarRiskBudget <= 0) return 0; // no room — refuse trade
  const qty = Math.floor(dollarRiskBudget / dollarStopPerContract);
  return Math.max(0, Math.min(spec.maxContracts, qty));
}

// Executes entry order.
// manualQty (optional): when set by an operator button press, bypass the DD-aware
// sizer entirely and use this quantity (always 1 for manual fires). The sizer's
// job is automated signal sizing — manual overrides just want 1 contract.
function enterTrade(symbol, direction, entryPrice, strategy, atr, sessionRegime, manualQty = null) {
  const acc = portfolio.accounts[symbol];
  if (!acc || acc.status === 'FAILED') return null;
  if (acc.enabled === false) {
    console.log(`[PaperEngine] Entry blocked for ${symbol}: Trading is toggled OFF.`);
    return null;
  }
  if (acc.activePosition) return null; // Only 1 active trade at a time

  const spec = CONTRACT_SPECS[symbol];

  // Compute stop distance (used for SL/TP price calculation regardless of sizing path)
  const slTicks0 = Math.round((atr * sessionRegime.atrStopMultiplier) / spec.tickSize);
  const stopDistance = slTicks0 * spec.tickSize;

  let qty;
  if (manualQty != null && manualQty >= 1) {
    // Operator-initiated: bypass the DD sizer, use exactly the requested qty.
    // This ensures BUY/SELL buttons always work regardless of account DD state.
    qty = Math.min(manualQty, spec.maxContracts || 10);
    console.log(`[PaperEngine] Manual entry for ${symbol}: bypassing sizer, qty=${qty}`);
  } else {
    qty = _sizePosition(acc, spec, stopDistance, direction);
    if (qty < 1) {
      console.log(`[PaperEngine] Entry refused for ${symbol}: position sizer returned 0 (no DD room).`);
      return null;
    }
  }

  // Detect whether NT8 is actively feeding this symbol (< 5 min since last METRICS push).
  // For live accounts: NT8 is source-of-truth — skip internal simulation artifacts.
  // For paper accounts (no NT8 chart connected): use full internal simulation.
  const isNT8Live = acc.tradingMode === 'live' &&
    acc.lastNt8Update && (Date.now() - acc.lastNt8Update < 300000);

  // For paper accounts only: deduct estimated round-trip commission at entry
  if (!isNT8Live) {
    const entryCommission = (spec.commRound / 2) * qty;
    acc.balance -= entryCommission;
  }

  // For live accounts: no slippage — NT8 handles real execution and fills.
  // For paper accounts: add 1 tick of simulated entry slippage.
  const slippageAmount = isNT8Live ? 0 : (spec.tickSize * (direction === 'Long' ? 1 : -1));
  const actualEntryPrice = entryPrice + slippageAmount;

  // Sizing stop-loss and take-profit based on ATR
  const slTicks = Math.round((atr * sessionRegime.atrStopMultiplier) / spec.tickSize);
  const tpTicks = Math.round((atr * sessionRegime.atrTargetMultiplier) / spec.tickSize);
  
  const stopLossPrice = actualEntryPrice + (slTicks * spec.tickSize * (direction === 'Long' ? -1 : 1));
  const takeProfitPrice = actualEntryPrice + (tpTicks * spec.tickSize * (direction === 'Long' ? 1 : -1));

  const beTriggerPrice = actualEntryPrice + (sessionRegime.atrBreakevenMultiplier * atr * (direction === 'Long' ? 1 : -1));
  // Trail starts at BE level (same trigger) — no extra delay.
  // Step is 0.25×ATR ≈ one 1-min candle. The 1.5× factor was removed 2026-05-26.
  const trailTriggerPrice = beTriggerPrice;   // was: atrBreakevenMultiplier * 1.5 * atr

  const position = {
    direction,
    entryPrice: actualEntryPrice,
    qty,
    stopLoss: stopLossPrice,
    takeProfit: takeProfitPrice,
    initialSL: stopLossPrice,
    strategyUsed: strategy,
    entryTime: new Date().toISOString(),
    unrealizedPnL: 0,
    breakevenTriggered: false,
    atr: atr,
    beTriggerPrice: beTriggerPrice,
    trailTriggerPrice: trailTriggerPrice
  };

  acc.activePosition = position;
  savePortfolioState();

  const msg = `⚡️ *NEW TRADE ENTERED* ⚡️\n` +
              `• Symbol: ${symbol} (${spec.name})\n` +
              `• Strategy: ${strategy}\n` +
              `• Action: ${direction} @ ${actualEntryPrice.toFixed(2)}\n` +
              `• Size: ${qty} Contracts\n` +
              `• Stop Loss: ${stopLossPrice.toFixed(2)}\n` +
              `• Take Profit: ${takeProfitPrice.toFixed(2)}\n` +
              `• ATR (Volatility): ${atr.toFixed(2)}`;

  sendTelegramMessage(msg);
  return position;
}

// Updates open trades in real time and enforces APX Drawdown Rules
function updatePortfolioMetrics(currentPrices, sessionRegime) {
  let stateChanged = false;

  for (const symbol of Object.keys(portfolio.accounts)) {
    const acc = portfolio.accounts[symbol];
    if (acc.status === 'FAILED') continue;

    // Check if NT8 connection is active (e.g. received update in the last 5 minutes)
    const isNT8Active = acc.lastNt8Update && (Date.now() - acc.lastNt8Update < 300000);
    if (isNT8Active) {
      // NinjaTrader 8 has absolute authority over metrics and trades. Skip simulated ticking/drawdown drift entirely!
      continue;
    }

    const currentPrice = currentPrices[symbol];
    if (!currentPrice) continue;

    const spec = CONTRACT_SPECS[symbol];
    const pos = acc.activePosition;

    if (pos) {
      // Calculate open trade unrealized profit
      const priceDiff = currentPrice - pos.entryPrice;
      const pointsDiff = priceDiff * (pos.direction === 'Long' ? 1 : -1);
      pos.unrealizedPnL = pointsDiff * spec.pointVal * pos.qty;

      const accountEquity = acc.balance + pos.unrealizedPnL;

      // 1. Drawdown calculation (ONLY FOR PROP EVAL & PA — not Standard)
      if (acc.mode !== 'Standard') {
        // isFlat=false: we have an open position — EOD accounts don't advance floor here
        _updatePeakAndFloor(acc, accountEquity, false);

        // Check failure condition — firm doesn't matter, breach is breach
        if (accountEquity <= acc.drawdownFloor) {
          const firm = acc.firmType === 'EOD' ? 'TopStep/EOD' : 'APEX';
          closeTrade(symbol, currentPrice, `${firm} Drawdown Limit Breached (Liquidated)`);
          acc.status = 'FAILED';
          stateChanged = true;
          continue;
        }
      } else {
        // Universal Standard Broker Account tracks peak equity but has no trailing drawdown floor
        acc.peakEquity = Math.max(acc.peakEquity, accountEquity);
        acc.drawdownFloor = 0;
      }

      // 2. Trailing Stop & Breakeven logic
      const ticksProfit = pointsDiff / spec.tickSize;
      const atrProfit = pointsDiff / pos.atr;

      // Breakeven Move
      if (!pos.breakevenTriggered && atrProfit >= sessionRegime.atrBreakevenMultiplier) {
        pos.stopLoss = pos.entryPrice; // Move to entry price
        pos.breakevenTriggered = true;
        stateChanged = true;
        console.log(`[PaperEngine] Moved stop to breakeven for ${symbol}`);
        sendTelegramMessage(`🛡️ Stop moved to Breakeven for ${symbol} @ ${pos.entryPrice.toFixed(2)}`);
      }

      // Dynamic ATR Trailing Stop
      if (atrProfit >= sessionRegime.atrBreakevenMultiplier * 1.5) {
        // Trail stop at a distance of 1.5x ATR behind current peak price
        const trailDist = pos.atr * sessionRegime.atrTrailingMultiplier;
        const newStop = currentPrice + (trailDist * (pos.direction === 'Long' ? -1 : 1));

        // Only move stop in our favor
        if (pos.direction === 'Long' && newStop > pos.stopLoss) {
          pos.stopLoss = newStop;
          stateChanged = true;
        } else if (pos.direction === 'Short' && newStop < pos.stopLoss) {
          pos.stopLoss = newStop;
          stateChanged = true;
        }
      }

      // 3. Stop-Loss & Take-Profit exits
      if (pos.direction === 'Long') {
        if (currentPrice <= pos.stopLoss) {
          closeTrade(symbol, pos.stopLoss, 'Stop Loss Triggered');
          stateChanged = true;
        } else if (currentPrice >= pos.takeProfit) {
          closeTrade(symbol, pos.takeProfit, 'Take Profit Triggered');
          stateChanged = true;
        }
      } else {
        if (currentPrice >= pos.stopLoss) {
          closeTrade(symbol, pos.stopLoss, 'Stop Loss Triggered');
          stateChanged = true;
        } else if (currentPrice <= pos.takeProfit) {
          closeTrade(symbol, pos.takeProfit, 'Take Profit Triggered');
          stateChanged = true;
        }
      }
    } else {
      // Empty position — balance IS equity. Both APEX and EOD advance their
      // floor here (isFlat=true) when a new balance high is reached.
      if (acc.mode !== 'Standard') {
        _updatePeakAndFloor(acc, acc.balance, true);
      } else if (acc.balance > acc.peakEquity) {
        acc.peakEquity    = acc.balance;
        acc.drawdownFloor = 0;
      }

      // Check evaluation profit target passed (ONLY IN EVALUATION MODE)
      if (acc.mode === 'Evaluation' && acc.balance >= INITIAL_BALANCE + PROFIT_TARGET && !acc.passed) {
        acc.passed = true;
        stateChanged = true;
        console.log(`[PaperEngine] ${symbol} account PASSED evaluation!`);
        sendTelegramMessage(`🎉 *CONGRATULATIONS* 🎉\nYour ${symbol} account has PASSED evaluation! Target of $53,000 met.`);
      }
    }
  }

  if (stateChanged) savePortfolioState();
}

// Resets and changes account mode dynamically.
//   mode       : 'Standard' | 'Evaluation' | 'PA'
//   firmType   : 'APEX' (intraday trailing DD) | 'EOD' (TopStep end-of-day trailing)
//   ddAmount   : optional override for this account's max trailing drawdown (number)
function changeAccountMode(symbol, mode, firmType, ddAmount) {
  const acc = portfolio.accounts[symbol];
  if (!acc) return false;

  acc.mode   = mode;
  if (firmType) acc.firmType = firmType;  // preserve existing firmType if not passed
  if (typeof ddAmount === 'number' && ddAmount > 0) acc.drawdownAmount = ddAmount;

  acc.balance    = INITIAL_BALANCE;
  acc.peakEquity = INITIAL_BALANCE;
  acc.status     = 'Active';
  acc.passed     = false;

  const ddAmt = _getDrawdownAmount(acc);
  if (mode === 'Standard') {
    acc.drawdownFloor = 0; // Universal Standard mode has no drawdown floor
  } else {
    acc.drawdownFloor = INITIAL_BALANCE - ddAmt;
  }

  const firmLabel = acc.firmType === 'EOD' ? 'TopStep/EOD' : 'APEX';
  savePortfolioState();
  sendTelegramMessage(`🔧 *ACCOUNT MODE CHANGED* 🔧\nSub-Account ${symbol} transitioned to *${mode} Mode* (${firmLabel} rules). DD floor: $${acc.drawdownFloor.toLocaleString()}. Universal settings applied.`);
  return true;
}

// Executes exit order
function closeTrade(symbol, exitPrice, reason) {
  const acc = portfolio.accounts[symbol];
  if (!acc || !acc.activePosition) return;

  const spec = CONTRACT_SPECS[symbol];
  const pos = acc.activePosition;

  // Add 1 tick of simulated exit slippage
  const slippageAmount = spec.tickSize * (pos.direction === 'Long' ? -1 : 1);
  const actualExitPrice = exitPrice + slippageAmount;

  const priceDiff = actualExitPrice - pos.entryPrice;
  const pointsDiff = priceDiff * (pos.direction === 'Long' ? 1 : -1);
  const grossProfit = pointsDiff * spec.pointVal * pos.qty;

  // Deduct exit commission fee
  const exitCommission = (spec.commRound / 2) * pos.qty;
  const netProfit = grossProfit - exitCommission;

  acc.balance += netProfit;
  acc.activePosition = null;

  const tradeRecord = {
    symbol,
    direction: pos.direction,
    entryPrice: pos.entryPrice,
    exitPrice: actualExitPrice,
    qty: pos.qty,
    strategyUsed: pos.strategyUsed,
    entryTime: pos.entryTime,
    exitTime: new Date().toISOString(),
    profit: netProfit,
    reason,
    accountNumber: acc.accountNumber || ''
  };

  portfolio.history.unshift(tradeRecord);
  savePortfolioState();

  const msg = `📉 *TRADE CLOSED* 📉\n` +
              `• Symbol: ${symbol} (${spec.name})\n` +
              `• Strategy: ${pos.strategyUsed}\n` +
              `• Exit Reason: ${reason}\n` +
              `• Direction: ${pos.direction}\n` +
              `• Entry Price: ${pos.entryPrice.toFixed(2)}\n` +
              `• Exit Price: ${actualExitPrice.toFixed(2)}\n` +
              `• Profit/Loss: $${netProfit.toFixed(2)}\n` +
              `• Current Balance: $${acc.balance.toFixed(2)}`;

  sendTelegramMessage(msg);
  
  // Proactively call Google Sheets logging webhook
  const { logTradeToGoogleSheets } = require('./googleSheets');
  logTradeToGoogleSheets(tradeRecord);

  // Proactively execute automated trade audit and self-tuning strategy refinement!
  try {
    const { auditRecentTrades } = require('./tradeAuditor');
    auditRecentTrades(tradeRecord);
  } catch (auditErr) {
    console.error('[PaperEngine] TradeAuditor trigger failed:', auditErr.message);
  }

  return tradeRecord;
}

// Transition account to Performance Account / Funded Mode.
// Works for both APEX PA and TopStep Funded — firmType is preserved from Evaluation.
function transitionToPAAccount(symbol) {
  const acc = portfolio.accounts[symbol];
  if (!acc || !acc.passed) return false;

  const ddAmt    = _getDrawdownAmount(acc);
  const firm     = acc.firmType || 'APEX';
  const firmLabel = firm === 'EOD' ? 'TopStep Funded' : 'APEX PA';

  acc.mode          = 'PA';
  acc.balance       = INITIAL_BALANCE;   // Reset to PA starting balance
  acc.peakEquity    = INITIAL_BALANCE;
  acc.drawdownFloor = INITIAL_BALANCE - ddAmt;
  acc.status        = 'Active';
  savePortfolioState();

  const floorNote = firm === 'APEX'
    ? `Running live risk floors locked at $${(INITIAL_BALANCE + 100).toLocaleString()}.`
    : `EOD trailing floor starts at $${acc.drawdownFloor.toLocaleString()} — only advances on realized gains.`;
  sendTelegramMessage(`🚀 *${firmLabel} TRANSITION* 🚀\nAccount ${symbol} successfully transitioned to ${firmLabel} Mode. ${floorNote}`);
  return true;
}

// Update account number dynamically
function updateAccountNumber(symbol, accountNumber) {
  const acc = portfolio.accounts[symbol];
  if (!acc) return false;
  acc.accountNumber = accountNumber.trim();
  savePortfolioState();
  return true;
}

// Update the firm type for a single account without resetting balances.
// Use when switching an account between APEX and TopStep rules mid-session.
function setFirmType(symbol, firmType) {
  const acc = portfolio.accounts[symbol];
  if (!acc) return { ok: false, error: 'unknown symbol' };
  const ft = String(firmType || '').toUpperCase();
  if (ft !== 'APEX' && ft !== 'EOD') return { ok: false, error: 'firmType must be APEX or EOD' };
  acc.firmType = ft;
  savePortfolioState();
  return { ok: true, symbol, firmType: ft };
}

// Update the trailing drawdown amount for a single account without resetting balances.
// The new floor is immediately recalculated from the current peak equity.
function setDrawdownAmount(symbol, amount) {
  const acc = portfolio.accounts[symbol];
  if (!acc) return { ok: false, error: 'unknown symbol' };
  const amt = Number(amount);
  if (!amt || amt <= 0) return { ok: false, error: 'amount must be a positive number' };
  acc.drawdownAmount = amt;
  // Recalculate floor immediately from current peak
  if (acc.mode !== 'Standard') {
    const isPA = acc.mode === 'PA';
    if (acc.firmType === 'APEX' && isPA) {
      acc.drawdownFloor = Math.min(INITIAL_BALANCE + 100, acc.peakEquity - amt);
    } else {
      acc.drawdownFloor = acc.peakEquity - amt;
    }
  }
  savePortfolioState();
  return { ok: true, symbol, drawdownAmount: amt, drawdownFloor: acc.drawdownFloor };
}

// Toggle symbol active/inactive status
function toggleSymbolEnabled(symbol, enabled, currentPrice = null) {
  const acc = portfolio.accounts[symbol];
  if (!acc) return false;
  acc.enabled = enabled;
  
  // Broadcast active status (ON/OFF) to NinjaTrader 8 strategy
  const { sendSignalToNT8 } = require('./nt8Bridge');
  sendSignalToNT8('STATUS', symbol, enabled ? 1 : 0, 0, 0, 0);
  
  if (enabled === false) {
    if (acc.activePosition) {
      console.log(`[PaperEngine] Symbol ${symbol} toggled OFF. Force closing active position...`);
      const exitPrice = currentPrice || acc.activePosition.entryPrice;
      
      // Close the trade in the paper engine
      closeTrade(symbol, exitPrice, 'Symbol Trading Toggled OFF (Forced Close)');
      
      // Send close signal to connected NT8 chart strategy
      sendSignalToNT8('CLOSE', symbol, 0, 0, 0, 0);
    }
  }
  
  savePortfolioState();
  sendTelegramMessage(`🔧 *SYMBOL STATUS CHANGED* 🔧\n${symbol} has been turned *${enabled ? 'ON' : 'OFF'}*. ${enabled ? 'Trades can now be executed.' : 'All incoming trades are suspended.'}`);
  return true;
}

// Registered callback — fired when a position transitions from active → Flat.
// Signature: (symbol, closedPosition, tradePnL, cumulativeRealized)
let _onPositionClose = null;
function setOnPositionClose(cb) { _onPositionClose = cb; }

// Update live metrics from NinjaTrader 8
function updateLiveMetricsFromNT8(symbol, balance, realized, unrealized, positionInfo) {
  // positionInfo (optional) shape:
  //   { marketPosition: 'Long'|'Short'|'Flat', qty: <int>, avgPrice: <float> }
  // If provided, direction comes from NT8 truth — NOT from sign of P&L (which is wrong:
  // a Long can be losing, a Short can be winning).
  const acc = portfolio.accounts[symbol];
  if (!acc) return false;

  // Snapshot previous state before mutating — needed for close-detection callback
  const prevPosition  = acc.activePosition;
  const prevRealized  = acc.nt8RealizedPnL || 0;

  // Direct 1:1 synchronization of the actual portfolio object properties!
  acc.balance = balance;
  acc.nt8Balance = balance;
  acc.nt8RealizedPnL = realized;
  acc.nt8UnrealizedPnL = unrealized;
  acc.lastNt8Update = Date.now();

  const spec = CONTRACT_SPECS[symbol];

  // Determine if there is a real position. Prefer authoritative position info
  // from NT8; fall back to non-zero unrealized P&L for backwards compatibility.
  const hasPositionFromInfo = positionInfo && positionInfo.marketPosition && positionInfo.marketPosition !== 'Flat';
  const hasPositionFallback = Math.abs(unrealized) > 0.01;
  const hasPosition = positionInfo ? hasPositionFromInfo : hasPositionFallback;

  if (hasPosition) {
    // Direction: from NT8 truth, or fallback warning if not provided
    const direction = positionInfo
      ? positionInfo.marketPosition
      : (unrealized > 0 ? 'Long' : 'Short'); // legacy fallback — known unreliable
    const qty = positionInfo && positionInfo.qty ? Math.abs(positionInfo.qty) : (spec ? spec.maxContracts : 2);
    const avgPrice = positionInfo && positionInfo.avgPrice ? positionInfo.avgPrice : 0;

    if (!acc.activePosition) {
      acc.activePosition = {
        direction,
        entryPrice: avgPrice,
        qty,
        stopLoss: 0,
        takeProfit: 0,
        strategyUsed: 'NT8 Live Mirror',
        entryTime: new Date().toISOString(),
        unrealizedPnL: unrealized
      };
    } else {
      // Update direction and price too if NT8 says it changed (rare but possible after a reversal)
      if (positionInfo) {
        acc.activePosition.direction = direction;
        if (avgPrice > 0) acc.activePosition.entryPrice = avgPrice;
        acc.activePosition.qty = qty;
      }
      acc.activePosition.unrealizedPnL = unrealized;
    }
  } else {
    acc.activePosition = null;
    // Fire position-close callback if a position just closed (prevPosition existed but now Flat)
    if (prevPosition && _onPositionClose) {
      try {
        const tradePnL = realized - prevRealized;
        _onPositionClose(symbol, prevPosition, tradePnL, realized);
      } catch (e) { /* non-fatal */ }
    }
  }

  // Drawdown safety floor — sync from NT8 balance/equity using firm-specific rules
  const totalEquity = balance + unrealized;
  const isNowFlat   = !acc.activePosition;   // re-read: position was just set above
  if (acc.mode !== 'Standard') {
    _updatePeakAndFloor(acc, totalEquity, isNowFlat);
  } else if (totalEquity > acc.peakEquity) {
    acc.peakEquity    = totalEquity;
    acc.drawdownFloor = 0;
  }

  savePortfolioState();
  return true;
}

module.exports = {
  loadPortfolioState,
  getPortfolioState,
  enterTrade,
  updatePortfolioMetrics,
  closeTrade,
  transitionToPAAccount,
  changeAccountMode,
  updateAccountNumber,
  toggleSymbolEnabled,
  updateLiveMetricsFromNT8,
  setOnPositionClose,
  CONTRACT_SPECS,
  // Micros + contract mode
  FAMILIES,
  MINI_SYMBOLS,
  MICRO_SYMBOLS,
  ALL_SYMBOLS,
  familyMiniSymbol,
  familyMicroSymbol,
  activeContractFor,
  activeSymbols,
  setContractMode,
  getContractMode,
  setFamilyContract,
  getFamilyContracts,
  resetAllAccounts,
  resetSymbolAccount,
  setAccountTradingMode,
  setFirmType,
  setDrawdownAmount
};
