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
    'NQ=F': { balance: INITIAL_BALANCE, peakEquity: INITIAL_BALANCE, drawdownFloor: INITIAL_BALANCE - DRAWDOWN_LIMIT, activePosition: null, status: 'Active', passed: false, mode: 'Evaluation' },
    'ES=F': { balance: INITIAL_BALANCE, peakEquity: INITIAL_BALANCE, drawdownFloor: INITIAL_BALANCE - DRAWDOWN_LIMIT, activePosition: null, status: 'Active', passed: false, mode: 'Evaluation' },
    'CL=F': { balance: INITIAL_BALANCE, peakEquity: INITIAL_BALANCE, drawdownFloor: INITIAL_BALANCE - DRAWDOWN_LIMIT, activePosition: null, status: 'Active', passed: false, mode: 'Evaluation' },
    'GC=F': { balance: INITIAL_BALANCE, peakEquity: INITIAL_BALANCE, drawdownFloor: INITIAL_BALANCE - DRAWDOWN_LIMIT, activePosition: null, status: 'Active', passed: false, mode: 'Evaluation' }
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

  for (const sym of Object.keys(portfolio.accounts)) {
    const acc = portfolio.accounts[sym];
    totalBalance += acc.balance;
    if (acc.activePosition) {
      totalOpenPnL += acc.activePosition.unrealizedPnL;
    }
  }

  return {
    ...portfolio,
    totalBalance,
    totalEquity: totalBalance + totalOpenPnL,
    totalOpenPnL
  };
}

// Executes entry order
function enterTrade(symbol, direction, entryPrice, strategy, atr, sessionRegime) {
  const acc = portfolio.accounts[symbol];
  if (!acc || acc.status === 'FAILED') return null;
  if (acc.activePosition) return null; // Only 1 active trade at a time

  const spec = CONTRACT_SPECS[symbol];
  const qty = spec.maxContracts; // e.g., 2 contracts max

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
    atr: atr
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
    reason
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

module.exports = {
  loadPortfolioState,
  getPortfolioState,
  enterTrade,
  updatePortfolioMetrics,
  closeTrade,
  transitionToPAAccount,
  changeAccountMode,
  CONTRACT_SPECS
};
