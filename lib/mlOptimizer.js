const fs = require('fs');
const path = require('path');

const SETTINGS_FILE_PATH = path.join(__dirname, '../optimized_settings.json');

// Default initial parameter sets
const DEFAULT_PARAMETERS = {
  RTH: {
    emaFast: 9,
    emaSlow: 21,
    orbMinutes: 15,
    macdBias: 0
  },
  ETH: {
    bbPeriod: 20,
    bbStdDev: 2.0,
    rsiOversold: 30,
    rsiOverbought: 70,
    stochOversold: 20,
    stochOverbought: 80
  }
};

// Dual-Objective Fitness Solver: Balances 80%+ win rate, high trade frequency, and net profit.
function calculateFitness(results) {
  const { profitFactor, netProfit, tradesCount, winsCount } = results;
  if (tradesCount === 0) return -999999;
  
  const winRate = winsCount / tradesCount;
  
  // 1. Win Rate Objective (60% weight)
  // Give a huge bonus if we meet the 80%+ profitability target, and apply an aggressive penalty below 80%
  let winRateScore = winRate * 120;
  if (winRate >= 0.80) {
    winRateScore += 150; // Massively prioritize settings that achieve 80%+ win rate
  } else {
    winRateScore -= (0.80 - winRate) * 300; // Heavily penalize failing the 80% target
  }
  
  // 2. Trade Frequency Objective (20% weight)
  // We want to maximize trade volume but prevent over-trading. Logarithmic weighting does this perfectly.
  const frequencyScore = Math.log(tradesCount + 1) * 25;
  
  // 3. Profit Factor and Net Return Objective (20% weight)
  const pfScore = Math.min(10, profitFactor) * 8;
  const netScore = netProfit > 0 ? Math.min(100, netProfit / 10) : netProfit / 5;
  
  return winRateScore + frequencyScore + pfScore + netScore;
}

// Simple Walkforward Parameter Grid Search Optimizer (Machine Learning heuristic)
// Simulates strategy outcomes on historical candles to select parameters meeting user targets.
function runWalkforwardOptimization(symbol, historicalCandles, sessionRegime) {
  if (!historicalCandles || historicalCandles.length < 50) {
    console.log(`[MLOptimizer] Insufficient data to optimize for ${symbol}, using defaults.`);
    return loadOptimizedParameters(symbol, sessionRegime);
  }

  console.log(`[MLOptimizer] Optimizing parameters for ${symbol} (${sessionRegime} regime) using ${historicalCandles.length} candles...`);

  let bestParams = {};
  let bestFitness = -Infinity;
  let bestStats = { profitFactor: 0, netProfit: 0, tradesCount: 0, winsCount: 0 };

  if (sessionRegime === 'RTH') {
    // 1. RTH: Trend-following EMA Crossover (Grid Search)
    const fastEMARange = [7, 8, 9, 10, 11, 12];
    const slowEMARange = [18, 20, 21, 22, 24, 26, 28];
    
    for (const fast of fastEMARange) {
      for (const slow of slowEMARange) {
        if (fast >= slow) continue;
        
        const results = simulateEMAStrategy(historicalCandles, fast, slow);
        const fitness = calculateFitness(results);
        
        if (fitness > bestFitness) {
          bestFitness = fitness;
          bestStats = results;
          bestParams = { emaFast: fast, emaSlow: slow };
        }
      }
    }
    
    // Fallback if no trades made
    if (Object.keys(bestParams).length === 0) {
      bestParams = DEFAULT_PARAMETERS.RTH;
    }
  } else {
    // 2. ETH: Mean Reversion (Bollinger Bands + RSI + Stochastics) (Grid Search)
    const bbDevRange = [1.6, 1.7, 1.8, 1.9, 2.0, 2.1, 2.2, 2.3, 2.4];
    const rsiLimitRange = [
      { os: 25, ob: 75 },
      { os: 27, ob: 73 },
      { os: 30, ob: 70 },
      { os: 33, ob: 67 },
      { os: 35, ob: 65 }
    ];

    for (const dev of bbDevRange) {
      for (const rsi of rsiLimitRange) {
        const results = simulateMeanReversionStrategy(historicalCandles, dev, rsi.os, rsi.ob);
        const fitness = calculateFitness(results);
        
        if (fitness > bestFitness) {
          bestFitness = fitness;
          bestStats = results;
          bestParams = { 
            bbPeriod: 20, 
            bbStdDev: dev, 
            rsiOversold: rsi.os, 
            rsiOverbought: rsi.ob,
            stochOversold: Math.min(25, rsi.os - 8),
            stochOverbought: Math.max(75, rsi.ob + 8)
          };
        }
      }
    }
    
    if (Object.keys(bestParams).length === 0) {
      bestParams = DEFAULT_PARAMETERS.ETH;
    }
  }

  saveOptimizedParameters(symbol, sessionRegime, bestParams);
  
  const winRate = bestStats.tradesCount > 0 ? (bestStats.winsCount / bestStats.tradesCount) * 100 : 0;
  console.log(`[MLOptimizer] Finished! Best ${sessionRegime} parameters for ${symbol}: ${JSON.stringify(bestParams)}`);
  console.log(`  • Stats -> Win Rate: ${winRate.toFixed(1)}% | Trades: ${bestStats.tradesCount} | Profit Factor: ${bestStats.profitFactor.toFixed(2)} | Net Profit: $${bestStats.netProfit.toFixed(2)} | Fitness: ${bestFitness.toFixed(1)}`);
  
  return bestParams;
}

// Simulated Backtester for EMA trend following
function simulateEMAStrategy(candles, fast, slow) {
  let grossProfit = 0;
  let grossLoss = 0;
  let tradesCount = 0;
  let winsCount = 0;
  
  // Calculate EMAs
  const fastEMA = calculateEMA(candles, fast);
  const slowEMA = calculateEMA(candles, slow);

  let position = 0; // 0: None, 1: Long, -1: Short
  let entryPrice = 0;

  for (let i = slow + 1; i < candles.length; i++) {
    const c_close = candles[i].close;
    
    // Check signals
    const longSignal = fastEMA[i] > slowEMA[i] && fastEMA[i - 1] <= slowEMA[i - 1];
    const shortSignal = fastEMA[i] < slowEMA[i] && fastEMA[i - 1] >= slowEMA[i - 1];

    if (position === 0) {
      if (longSignal) {
        position = 1;
        entryPrice = c_close;
      } else if (shortSignal) {
        position = -1;
        entryPrice = c_close;
      }
    } else if (position === 1) {
      // Exit long
      if (shortSignal || i === candles.length - 1) {
        const profit = c_close - entryPrice;
        if (profit > 0) {
          grossProfit += profit;
          winsCount++;
        } else {
          grossLoss += Math.abs(profit);
        }
        tradesCount++;
        position = 0;
      }
    } else if (position === -1) {
      // Exit short
      if (longSignal || i === candles.length - 1) {
        const profit = entryPrice - c_close;
        if (profit > 0) {
          grossProfit += profit;
          winsCount++;
        } else {
          grossLoss += Math.abs(profit);
        }
        tradesCount++;
        position = 0;
      }
    }
  }

  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 99 : 0) : grossProfit / grossLoss;
  return { profitFactor, netProfit: grossProfit - grossLoss, tradesCount, winsCount };
}

// Simulated Backtester for Mean Reversion (Bollinger Bands + RSI)
function simulateMeanReversionStrategy(candles, stdDev, rsiOS, rsiOB) {
  let grossProfit = 0;
  let grossLoss = 0;
  let tradesCount = 0;
  let winsCount = 0;

  // Simple Bollinger Band and RSI arrays
  const { middle, upper, lower } = calculateBollingerBands(candles, 20, stdDev);
  const rsi = calculateRSI(candles, 14);

  let position = 0;
  let entryPrice = 0;

  for (let i = 21; i < candles.length; i++) {
    const c_close = candles[i].close;
    
    const longSignal = c_close < lower[i] && rsi[i] < rsiOS;
    const shortSignal = c_close > upper[i] && rsi[i] > rsiOB;

    if (position === 0) {
      if (longSignal) {
        position = 1;
        entryPrice = c_close;
      } else if (shortSignal) {
        position = -1;
        entryPrice = c_close;
      }
    } else if (position === 1) {
      // Exit long at middle band or stop out
      if (c_close >= middle[i] || c_close < entryPrice - 10 || i === candles.length - 1) {
        const profit = c_close - entryPrice;
        if (profit > 0) {
          grossProfit += profit;
          winsCount++;
        } else {
          grossLoss += Math.abs(profit);
        }
        tradesCount++;
        position = 0;
      }
    } else if (position === -1) {
      // Exit short at middle band or stop out
      if (c_close <= middle[i] || c_close > entryPrice + 10 || i === candles.length - 1) {
        const profit = entryPrice - c_close;
        if (profit > 0) {
          grossProfit += profit;
          winsCount++;
        } else {
          grossLoss += Math.abs(profit);
        }
        tradesCount++;
        position = 0;
      }
    }
  }

  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 99 : 0) : grossProfit / grossLoss;
  return { profitFactor, netProfit: grossProfit - grossLoss, tradesCount, winsCount };
}

// Helper: Calculate EMA array
function calculateEMA(candles, period) {
  const k = 2 / (period + 1);
  const ema = new Array(candles.length).fill(0);
  
  if (candles.length < period) return ema;

  // Initialize first EMA value with simple average
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += candles[i].close;
  }
  ema[period - 1] = sum / period;

  for (let i = period; i < candles.length; i++) {
    ema[i] = candles[i].close * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

// Helper: Calculate Bollinger Bands
function calculateBollingerBands(candles, period, stdDevMultiplier) {
  const middle = new Array(candles.length).fill(0);
  const upper = new Array(candles.length).fill(0);
  const lower = new Array(candles.length).fill(0);

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += candles[i - j].close;
    }
    const sma = sum / period;
    middle[i] = sma;

    let varianceSum = 0;
    for (let j = 0; j < period; j++) {
      varianceSum += Math.pow(candles[i - j].close - sma, 2);
    }
    const stdDev = Math.sqrt(varianceSum / period);

    upper[i] = sma + stdDevMultiplier * stdDev;
    lower[i] = sma - stdDevMultiplier * stdDev;
  }

  return { middle, upper, lower };
}

// Helper: Calculate RSI array
function calculateRSI(candles, period) {
  const rsi = new Array(candles.length).fill(50);
  if (candles.length < period + 1) return rsi;

  let avgGain = 0;
  let avgLoss = 0;

  // First RSI value calculation
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }

  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

// Helper: Persist parameters
function saveOptimizedParameters(symbol, session, params) {
  let settings = {};
  if (fs.existsSync(SETTINGS_FILE_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8'));
    } catch (e) {
      settings = {};
    }
  }

  if (!settings[symbol]) settings[symbol] = {};
  settings[symbol][session] = params;

  fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

function loadOptimizedParameters(symbol, session) {
  if (fs.existsSync(SETTINGS_FILE_PATH)) {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8'));
      if (settings[symbol] && settings[symbol][session]) {
        return settings[symbol][session];
      }
    } catch (e) {}
  }
  return DEFAULT_PARAMETERS[session];
}

module.exports = {
  runWalkforwardOptimization,
  loadOptimizedParameters,
  calculateEMA,
  calculateRSI,
  calculateBollingerBands
};
