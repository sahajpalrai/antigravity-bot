const fs = require('fs');
const path = require('path');
const { sendTelegramMessage } = require('./telegram');

const PERSIST_FILE_PATH = path.join(__dirname, '../portfolio_state.json');

const INITIAL_BALANCE = 50000;
const DRAWDOWN_LIMIT = 2500;
const PROFIT_TARGET = 3000; // Pass at $53,000

// Future Symbol Contract Settings
const CONTRACT_SPECS = {
  'NQ=F': { name: 'E-mini Nasdaq-100', tickSize: 0.25, tickVal: 5.00, pointVal: 20.00, commRound: 4.00, maxContracts: 2 },
  'ES=F': { name: 'E-mini S&P 500', tickSize: 0.25, tickVal: 12.50, pointVal: 50.00, commRound: 4.00, maxContracts: 2 },
  'CL=F': { name: 'Crude Oil', tickSize: 0.01, tickVal: 10.00, pointVal: 1000.00, commRound: 4.00, maxContracts: 2 },
  'GC=F': { name: 'Gold', tickSize: 0.10, tickVal: 10.00, pointVal: 100.00, commRound: 4.00, maxContracts: 2 }
};

let portfolio = {
  accounts: {
    'NQ=F': { balance: INITIAL_BALANCE, peakEquity: INITIAL_BALANCE, drawdownFloor: INITIAL_BALANCE - DRAWDOWN_LIMIT, activePosition: null, status: 'Active', passed: false, mode: 'Evaluation', accountNumber: 'APX-NQ-50K-01', enabled: true },
    'ES=F': { balance: INITIAL_BALANCE, peakEquity: INITIAL_BALANCE, drawdownFloor: INITIAL_BALANCE - DRAWDOWN_LIMIT, activePosition: null, status: 'Active', passed: false, mode: 'Evaluation', accountNumber: 'APX-ES-50K-02', enabled: true },
    'CL=F': { balance: INITIAL_BALANCE, peakEquity: INITIAL_BALANCE, drawdownFloor: INITIAL_BALANCE - DRAWDOWN_LIMIT, activePosition: null, status: 'Active', passed: false, mode: 'Evaluation', accountNumber: 'APX-CL-50K-03', enabled: true },
    'GC=F': { balance: INITIAL_BALANCE, peakEquity: INITIAL_BALANCE, drawdownFloor: INITIAL_BALANCE - DRAWDOWN_LIMIT, activePosition: null, status: 'Active', passed: false, mode: 'Evaluation', accountNumber: 'APX-GC-50K-04', enabled: true }
  },
  history: []
};

// Load saved state if it exists
function loadPortfolioState() {
  if (fs.existsSync(PERSIST_FILE_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(PERSIST_FILE_PATH, 'utf-8'));
      if (saved.accounts) {
        portfolio = saved;
        
        // Dynamically assign realistic default account numbers if loaded from old state
        const defaults = {
          'NQ=F': 'APX-NQ-50K-01',
          'ES=F': 'APX-ES-50K-02',
          'CL=F': 'APX-CL-50K-03',
          'GC=F': 'APX-GC-50K-04'
        };
        
        for (const sym of Object.keys(portfolio.accounts)) {
          if (!portfolio.accounts[sym].accountNumber) {
            portfolio.accounts[sym].accountNumber = defaults[sym];
          }
          if (portfolio.accounts[sym].enabled === undefined) {
            portfolio.accounts[sym].enabled = true; // default to true
          }
        }
        console.log('[PaperEngine] Portfolio state successfully loaded.');
      }
    } catch (e) {
      console.error('[PaperEngine] Failed to load portfolio state, using defaults.');
    }
  }
}

function savePortfolioState() {
  fs.writeFileSync(PERSIST_FILE_PATH, JSON.stringify(portfolio, null, 2), 'utf-8');
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

    let activePosition = acc.activePosition;
    if (isNT8Active) {
      if (Math.abs(unrealizedPnL) > 0.01) {
        if (!activePosition) {
          // Synthesize an NT8 live active position
          activePosition = {
            direction: unrealizedPnL > 0 ? 'Long' : 'Short',
            entryPrice: 0,
            qty: spec ? spec.maxContracts : 2,
            stopLoss: 0,
            takeProfit: 0,
            strategyUsed: 'NT8 Live Mirror',
            entryTime: new Date().toISOString(),
            unrealizedPnL: unrealizedPnL
          };
        } else {
          // Keep the existing activePosition but override its P&L
          activePosition = {
            ...activePosition,
            unrealizedPnL
          };
        }
      } else {
        // NT8 says no active position (P&L is 0)
        activePosition = null;
      }
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

// Executes entry order
function enterTrade(symbol, direction, entryPrice, strategy, atr, sessionRegime) {
  const acc = portfolio.accounts[symbol];
  if (!acc || acc.status === 'FAILED') return null;
  if (acc.enabled === false) {
    console.log(`[PaperEngine] Entry blocked for ${symbol}: Trading is toggled OFF.`);
    return null;
  }
  if (acc.activePosition) return null; // Only 1 active trade at a time

  const spec = CONTRACT_SPECS[symbol];

  // Compute stop distance first (to feed into the position sizer)
  const slTicks0 = Math.round((atr * sessionRegime.atrStopMultiplier) / spec.tickSize);
  const stopDistance = slTicks0 * spec.tickSize;
  const qty = _sizePosition(acc, spec, stopDistance, direction);
  if (qty < 1) {
    console.log(`[PaperEngine] Entry refused for ${symbol}: position sizer returned 0 (no DD room).`);
    return null;
  }

  // Apply entry commission fee immediately
  const entryCommission = (spec.commRound / 2) * qty;
  acc.balance -= entryCommission;

  // Add 1 tick of simulated entry slippage
  const slippageAmount = spec.tickSize * (direction === 'Long' ? 1 : -1);
  const actualEntryPrice = entryPrice + slippageAmount;

  // Sizing stop-loss and take-profit based on ATR
  const slTicks = Math.round((atr * sessionRegime.atrStopMultiplier) / spec.tickSize);
  const tpTicks = Math.round((atr * sessionRegime.atrTargetMultiplier) / spec.tickSize);
  
  const stopLossPrice = actualEntryPrice + (slTicks * spec.tickSize * (direction === 'Long' ? -1 : 1));
  const takeProfitPrice = actualEntryPrice + (tpTicks * spec.tickSize * (direction === 'Long' ? 1 : -1));

  const beTriggerPrice = actualEntryPrice + (sessionRegime.atrBreakevenMultiplier * atr * (direction === 'Long' ? 1 : -1));
  const trailTriggerPrice = actualEntryPrice + (sessionRegime.atrBreakevenMultiplier * 1.5 * atr * (direction === 'Long' ? 1 : -1));

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

      // 1. Drawdown calculation (ONLY FOR APX EVALUATION & PA RUNNERS)
      if (acc.mode !== 'Standard') {
        if (accountEquity > acc.peakEquity) {
          acc.peakEquity = accountEquity;
          
          // PA Mode locks trailing floor once it hits $50,100
          if (acc.mode === 'PA') {
            acc.drawdownFloor = Math.min(50100, acc.peakEquity - DRAWDOWN_LIMIT);
          } else {
            acc.drawdownFloor = acc.peakEquity - DRAWDOWN_LIMIT;
          }
        }

        // Check failure condition
        if (accountEquity <= acc.drawdownFloor) {
          closeTrade(symbol, currentPrice, 'APX Drawdown Limit Breached (Liquidated)');
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
      // Empty position, equity equals balance
      if (acc.balance > acc.peakEquity) {
        acc.peakEquity = acc.balance;
        if (acc.mode !== 'Standard') {
          if (acc.mode === 'PA') {
            acc.drawdownFloor = Math.min(50100, acc.peakEquity - DRAWDOWN_LIMIT);
          } else {
            acc.drawdownFloor = acc.peakEquity - DRAWDOWN_LIMIT;
          }
        } else {
          acc.drawdownFloor = 0;
        }
      }

      // Check APX evaluation passed target ($53,000) (ONLY IN EVALUATION MODE)
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

// Resets and changes account mode dynamically
function changeAccountMode(symbol, mode) {
  const acc = portfolio.accounts[symbol];
  if (!acc) return false;

  acc.mode = mode; // 'Standard', 'Evaluation', 'PA'
  acc.balance = INITIAL_BALANCE;
  acc.peakEquity = INITIAL_BALANCE;
  acc.status = 'Active';
  acc.passed = false;

  if (mode === 'Standard') {
    acc.drawdownFloor = 0; // Universal Standard mode has no drawdown floor
  } else {
    acc.drawdownFloor = INITIAL_BALANCE - DRAWDOWN_LIMIT;
  }

  savePortfolioState();
  sendTelegramMessage(`🔧 *ACCOUNT MODE CHANGED* 🔧\nSub-Account ${symbol} successfully transitioned to *${mode} Mode*. Universal settings applied.`);
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

// Transition APX account to Performance Account (PA) Mode
function transitionToPAAccount(symbol) {
  const acc = portfolio.accounts[symbol];
  if (!acc || !acc.passed) return false;

  acc.mode = 'PA';
  acc.balance = INITIAL_BALANCE; // Reset to PA starting balance
  acc.peakEquity = INITIAL_BALANCE;
  acc.drawdownFloor = INITIAL_BALANCE - DRAWDOWN_LIMIT;
  acc.status = 'Active';
  savePortfolioState();

  sendTelegramMessage(`🚀 *PA TRANSITION* 🚀\nAccount ${symbol} successfully transitioned to PA Mode (Performance Account). Running live risk floors locked at $50,100.`);
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

// Update live metrics from NinjaTrader 8
function updateLiveMetricsFromNT8(symbol, balance, realized, unrealized, positionInfo) {
  // positionInfo (optional) shape:
  //   { marketPosition: 'Long'|'Short'|'Flat', qty: <int>, avgPrice: <float> }
  // If provided, direction comes from NT8 truth — NOT from sign of P&L (which is wrong:
  // a Long can be losing, a Short can be winning).
  const acc = portfolio.accounts[symbol];
  if (!acc) return false;

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
  }

  // Drawdown safety floor updates (sync dynamic drawdown floor from NT8 balance/equity if active)
  const totalEquity = balance + unrealized;
  if (totalEquity > acc.peakEquity) {
    acc.peakEquity = totalEquity;
    if (acc.mode !== 'Standard') {
      if (acc.mode === 'PA') {
        acc.drawdownFloor = Math.min(50100, acc.peakEquity - DRAWDOWN_LIMIT);
      } else {
        acc.drawdownFloor = acc.peakEquity - DRAWDOWN_LIMIT;
      }
    }
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
  CONTRACT_SPECS
};
