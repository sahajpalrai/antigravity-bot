const fs = require('fs');
const path = require('path');

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
    // userMaxContracts: user-configurable ceiling applied by _sizePosition() ON TOP
    // of spec.maxContracts. Keeps the DD-sizer from over-sizing on micros.
    // Default 3 for micros (one-tenth of a full mini position), 2 for minis.
    userMaxContracts: CONTRACT_SPECS[symbol] && CONTRACT_SPECS[symbol].isMicro ? 3 : 2,
    // Per-account trading mode toggle. 'live' = NT8 is source-of-truth for
    // P&L and position state; 'paper' = internal simulation only.
  };
}

// Per-symbol reset — wipe one account back to fresh $50K balance + clear
// its history, BUT preserve every user-customized field so the reset only
// wipes the financial state, not the user's config.
function resetSymbolAccount(symbol) {
  if (!portfolio.accounts[symbol]) return { ok: false, error: 'unknown symbol' };
  const old = portfolio.accounts[symbol];
  // Capture every field the user might have customized
  const preserved = {
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
      // Backfill userMaxContracts for accounts saved before this field existed
      if (typeof a.userMaxContracts !== 'number') {
        a.userMaxContracts = CONTRACT_SPECS[sym] && CONTRACT_SPECS[sym].isMicro ? 3 : 2;
      }
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
    
    // NT8 is the ONLY source of truth (internal paper sim removed 2026-05-31).
    // Never synthesize money/positions from the sim — show NT8's numbers, or
    // flat / last-known balance when NT8 hasn't reported in the last 5 min.
    const balance = (acc.nt8Balance != null) ? acc.nt8Balance : acc.balance;
    const unrealizedPnL = isNT8Active ? (acc.nt8UnrealizedPnL || 0) : 0;
    const realizedPnL = (acc.nt8RealizedPnL != null) ? acc.nt8RealizedPnL : 0;

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
    // Only show a position NT8 has actually confirmed (fresh metrics). When NT8
    // is silent we show flat — never an optimistic/paper position.
    let activePosition = isNT8Active ? acc.activePosition : null;
    if (activePosition) {
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
// Returns an integer quantity in [1, effectiveMax] where effectiveMax is
// min(spec.maxContracts, acc.userMaxContracts) — user-configurable per account.
function _sizePosition(acc, spec, stopDistance, direction) {
  // User-configurable hard ceiling (default 3 — conservative starting point).
  // Separate from spec.maxContracts which is the exchange/prop-firm absolute limit.
  const userMax       = (typeof acc.userMaxContracts === 'number' && acc.userMaxContracts >= 1)
    ? acc.userMaxContracts : spec.maxContracts;
  const effectiveMax  = Math.min(spec.maxContracts, userMax);

  // Risk-per-trade: 25% of remaining DD room for Prop accounts; 1% balance for Standard
  const dollarStopPerContract = stopDistance * spec.pointVal;
  if (dollarStopPerContract <= 0) return 1;

  let dollarRiskBudget;
  const remainingDD = Math.max(0, acc.balance - acc.drawdownFloor);
  if (acc.mode === 'Standard') {
    dollarRiskBudget = acc.balance * 0.01;
  } else {
    dollarRiskBudget = remainingDD * 0.25;
  }

  if (dollarRiskBudget <= 0) return 0; // no room at all — refuse trade
  const qty = Math.floor(dollarRiskBudget / dollarStopPerContract);

  if (qty < 1) {
    // 25%-budget too small for even 1 contract (wide stop on high-vol instrument
    // like CL/MCL). Still allow 1 contract if the full 1-contract stop loss fits
    // within the TOTAL remaining DD room — otherwise the next bar's drawdown tick
    // would breach the floor anyway.
    // Example: MCL ATR=$5 → stop=$500 > 25% budget ($623×0.25) but $500 < $2493 DD → allow 1.
    return dollarStopPerContract <= remainingDD ? 1 : 0;
  }
  return Math.min(effectiveMax, qty);
}

// Set the user-configurable max-contracts cap for a single account.
// qty must be an integer >= 1. Does not reset balance or positions.
function setUserMaxContracts(symbol, qty) {
  const acc = portfolio.accounts[symbol];
  if (!acc) return { ok: false, error: 'unknown symbol' };
  const n = parseInt(qty, 10);
  if (!n || n < 1) return { ok: false, error: 'qty must be a positive integer' };
  acc.userMaxContracts = n;
  savePortfolioState();
  return { ok: true, symbol, userMaxContracts: n };
}

// Prepares a live entry: computes position size, SL/TP levels, stores position.
// NO simulation — NT8 executes the actual trade. This only records the intent
// so the dashboard and brain panel can display the open position.
// manualQty: when set (operator button), bypass DD sizer and use this quantity.
function prepareEntry(symbol, direction, entryPrice, strategy, atr, sessionRegime, manualQty = null) {
  const acc = portfolio.accounts[symbol];
  if (!acc || acc.status === 'FAILED') return null;
  if (acc.enabled === false) {
    console.log(`[AccountEngine] Entry blocked for ${symbol}: symbol is OFF.`);
    return null;
  }
  if (acc.activePosition) return null; // 1 position at a time

  const spec = CONTRACT_SPECS[symbol];
  const slTicks = Math.round((atr * sessionRegime.atrStopMultiplier) / spec.tickSize);
  const tpTicks = Math.round((atr * sessionRegime.atrTargetMultiplier) / spec.tickSize);
  const stopDistance = slTicks * spec.tickSize;

  let qty;
  if (manualQty != null && manualQty >= 1) {
    qty = Math.min(manualQty, spec.maxContracts || 10);
  } else {
    qty = _sizePosition(acc, spec, stopDistance, direction);
    if (qty < 1) {
      console.log(`[AccountEngine] Entry refused for ${symbol}: sizer returned 0.`);
      return null;
    }
  }

  const stopLossPrice   = entryPrice + (slTicks * spec.tickSize * (direction === 'Long' ? -1 : 1));
  const takeProfitPrice = entryPrice + (tpTicks * spec.tickSize * (direction === 'Long' ?  1 : -1));
  const beTriggerPrice  = entryPrice + (sessionRegime.atrBreakevenMultiplier * atr * (direction === 'Long' ? 1 : -1));

  const position = {
    direction,
    entryPrice,
    qty,
    stopLoss:  stopLossPrice,
    takeProfit: takeProfitPrice,
    initialSL:  stopLossPrice,
    strategyUsed: strategy,
    entryTime: new Date().toISOString(),
    unrealizedPnL: 0,
    breakevenTriggered: false,
    atr,
    beTriggerPrice,
    trailTriggerPrice: beTriggerPrice
  };

  acc.activePosition = position;
  savePortfolioState();
  return position;
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

  savePortfolioState();
  return true;
}

// Clears the active position record locally (no simulation).
// NT8 is the source of truth — call this only to sync dashboard state
// after the real NT8 order has been closed (or is being requested to close).
function clearActivePosition(symbol) {
  const acc = portfolio.accounts[symbol];
  if (!acc) return false;
  acc.activePosition = null;
  savePortfolioState();
  return true;
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
      console.log(`[AccountEngine] Symbol ${symbol} toggled OFF — clearing local position record.`);
      acc.activePosition = null;
      // Send close signal to connected NT8 chart strategy
      sendSignalToNT8('CLOSE', symbol, 0, 0, 0, 0);
    }
  }

  savePortfolioState();
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
  prepareEntry,
  clearActivePosition,
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
  setFirmType,
  setDrawdownAmount,
  setUserMaxContracts
};
