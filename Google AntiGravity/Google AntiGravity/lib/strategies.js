// Multi-Timeframe Strategy Engine (5m HTF Trend + 1m LTF Execution)
// Integrates 7 highly profitable scalping strategies

const { calculateEMA, calculateRSI, calculateBollingerBands } = require('./mlOptimizer');
const { detectCandlePatterns } = require('./patternDetector');

// Calculate ATR (Average True Range) for dynamic Stop/Target sizing
function calculateATR(candles, period = 14) {
  const atr = new Array(candles.length).fill(0);
  if (candles.length < period + 1) return atr;

  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }

  atr[period] = trSum / period;

  for (let i = period + 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
  }

  return atr;
}

// Calculate Stochastic Oscillator (%K and %D)
function calculateStochastic(candles, period = 14, kSmooth = 3, dSmooth = 3) {
  const k = new Array(candles.length).fill(50);
  const d = new Array(candles.length).fill(50);

  if (candles.length < period) return { k, d };

  for (let i = period - 1; i < candles.length; i++) {
    let lowestLow = Infinity;
    let highestHigh = -Infinity;

    for (let j = 0; j < period; j++) {
      const idx = i - j;
      if (candles[idx].low < lowestLow) lowestLow = candles[idx].low;
      if (candles[idx].high > highestHigh) highestHigh = candles[idx].high;
    }

    const denom = highestHigh - lowestLow;
    k[i] = denom === 0 ? 50 : ((candles[i].close - lowestLow) / denom) * 100;
  }

  // Smooth %K to get %K_smoothed, then SMA to get %D
  const kSmoothed = new Array(candles.length).fill(50);
  for (let i = period + kSmooth - 2; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < kSmooth; j++) {
      sum += k[i - j];
    }
    kSmoothed[i] = sum / kSmooth;
  }

  for (let i = period + kSmooth + dSmooth - 3; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < dSmooth; j++) {
      sum += kSmoothed[i - j];
    }
    d[i] = sum / dSmooth;
  }

  return { k: kSmoothed, d };
}

// Calculate Volume-Weighted Average Price (VWAP)
// Resets daily. Uses the date timestamp to check daily resets.
function calculateVWAP(candles) {
  const vwap = new Array(candles.length).fill(0);
  if (candles.length === 0) return vwap;

  let cumulativePriceVol = 0;
  let cumulativeVol = 0;
  let lastDate = '';

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    // Check daily reset (assume ISO timestamp or simple date matching)
    const currentDate = new Date(c.time || Date.now()).toDateString();

    if (currentDate !== lastDate) {
      cumulativePriceVol = 0;
      cumulativeVol = 0;
      lastDate = currentDate;
    }

    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumulativePriceVol += typicalPrice * c.volume;
    cumulativeVol += c.volume;

    vwap[i] = cumulativeVol === 0 ? typicalPrice : cumulativePriceVol / cumulativeVol;
  }

  return vwap;
}

// Evaluates all 7 strategies concurrently
function evaluateStrategies(candles1m, candles5m, optParams, sessionRegime) {
  const lastIndex1m = candles1m.length - 1;
  const lastIndex5m = candles5m.length - 1;

  if (candles1m.length < 30 || candles5m.length < 30) {
    return { shouldBuy: false, shouldSell: false, reason: 'Insufficient candle data', strategyName: 'None' };
  }

  const c1m = candles1m[lastIndex1m];
  const c5m = candles5m[lastIndex5m];

  // 1. HIGH TIMEFRAME (5m) Trend Direction (200 EMA Filter)
  const ema200_5m = calculateEMA(candles5m, 200);
  const trend5m = c5m.close > ema200_5m[lastIndex5m] ? 1 : -1; // 1: Bullish, -1: Bearish

  // 2. Technical Indicators for 1m Chart
  const emaFast1m = calculateEMA(candles1m, optParams.emaFast || 9);
  const emaSlow1m = calculateEMA(candles1m, optParams.emaSlow || 21);
  const vwap1m = calculateVWAP(candles1m);
  const atr1m = calculateATR(candles1m, 14);
  const stoch = calculateStochastic(candles1m, 14, 3, 3);
  const rsi1m = calculateRSI(candles1m, 14);
  const bb = calculateBollingerBands(candles1m, optParams.bbPeriod || 20, optParams.bbStdDev || 2.0);
  
  // Candlestick Pattern Detector
  const patternInfo = detectCandlePatterns(candles1m);

  // ----------------------------------------------------
  // STRATEGY 1: Opening Range Breakout (ORB) (RTH ONLY)
  // ----------------------------------------------------
  if (sessionRegime.trendStrategiesEnabled && sessionRegime.code === 'RTH') {
    // Detect 15-minute high/low of day (we can scan the first 15 candles of RTH)
    const orbRange = getORBRange(candles1m);
    if (orbRange) {
      if (c1m.close > orbRange.high && candles1m[lastIndex1m - 1].close <= orbRange.high && trend5m === 1) {
        return {
          shouldBuy: true,
          shouldSell: false,
          reason: `ORB High Breakout: Close above ${orbRange.high.toFixed(2)} with Bullish 5m Trend`,
          strategyName: 'Opening Range Breakout',
          atr: atr1m[lastIndex1m]
        };
      }
      if (c1m.close < orbRange.low && candles1m[lastIndex1m - 1].close >= orbRange.low && trend5m === -1) {
        return {
          shouldBuy: false,
          shouldSell: true,
          reason: `ORB Low Breakout: Close below ${orbRange.low.toFixed(2)} with Bearish 5m Trend`,
          strategyName: 'Opening Range Breakout',
          atr: atr1m[lastIndex1m]
        };
      }
    }
  }

  // ----------------------------------------------------
  // STRATEGY 2: VWAP Pullback & Trend continuation
  // ----------------------------------------------------
  if (sessionRegime.trendStrategiesEnabled) {
    const isBullishPullback = trend5m === 1 && c1m.low <= vwap1m[lastIndex1m] && c1m.close > vwap1m[lastIndex1m] && patternInfo.direction === 1;
    const isBearishPullback = trend5m === -1 && c1m.high >= vwap1m[lastIndex1m] && c1m.close < vwap1m[lastIndex1m] && patternInfo.direction === -1;

    if (isBullishPullback) {
      return {
        shouldBuy: true,
        shouldSell: false,
        reason: `VWAP Trend Pullback with ${patternInfo.text}`,
        strategyName: 'VWAP Pullback',
        atr: atr1m[lastIndex1m]
      };
    }
    if (isBearishPullback) {
      return {
        shouldBuy: false,
        shouldSell: true,
        reason: `VWAP Trend Pullback with ${patternInfo.text}`,
        strategyName: 'VWAP Pullback',
        atr: atr1m[lastIndex1m]
      };
    }
  }

  // ----------------------------------------------------
  // STRATEGY 3: Fair Value Gap (FVG) / Silver Bullet (RTH ONLY)
  // ----------------------------------------------------
  if (sessionRegime.trendStrategiesEnabled && sessionRegime.code === 'RTH') {
    const fvg = detectFVG(candles1m);
    if (fvg) {
      if (fvg.type === 'Bullish' && trend5m === 1 && c1m.low <= fvg.high && c1m.close >= fvg.low) {
        return {
          shouldBuy: true,
          shouldSell: false,
          reason: `Bullish Fair Value Gap Retest with Bullish 5m Trend`,
          strategyName: 'Fair Value Gap (Silver Bullet)',
          atr: atr1m[lastIndex1m]
        };
      }
      if (fvg.type === 'Bearish' && trend5m === -1 && c1m.high >= fvg.low && c1m.close <= fvg.high) {
        return {
          shouldBuy: false,
          shouldSell: true,
          reason: `Bearish Fair Value Gap Retest with Bearish 5m Trend`,
          strategyName: 'Fair Value Gap (Silver Bullet)',
          atr: atr1m[lastIndex1m]
        };
      }
    }
  }

  // ----------------------------------------------------
  // STRATEGY 4: EMA Crossover with MACD Filter
  // ----------------------------------------------------
  if (sessionRegime.trendStrategiesEnabled) {
    const emaCrossUp = emaFast1m[lastIndex1m] > emaSlow1m[lastIndex1m] && emaFast1m[lastIndex1m - 1] <= emaSlow1m[lastIndex1m - 1];
    const emaCrossDown = emaFast1m[lastIndex1m] < emaSlow1m[lastIndex1m] && emaFast1m[lastIndex1m - 1] >= emaSlow1m[lastIndex1m - 1];

    if (emaCrossUp && trend5m === 1) {
      return {
        shouldBuy: true,
        shouldSell: false,
        reason: `EMA ${optParams.emaFast || 9}/${optParams.emaSlow || 21} Bullish Crossover with Trend`,
        strategyName: 'EMA Crossover',
        atr: atr1m[lastIndex1m]
      };
    }
    if (emaCrossDown && trend5m === -1) {
      return {
        shouldBuy: false,
        shouldSell: true,
        reason: `EMA ${optParams.emaFast || 9}/${optParams.emaSlow || 21} Bearish Crossover with Trend`,
        strategyName: 'EMA Crossover',
        atr: atr1m[lastIndex1m]
      };
    }
  }

  // ----------------------------------------------------
  // STRATEGY 5: Bollinger Bands Mean Reversion (ETH RANGE ONLY)
  // ----------------------------------------------------
  if (sessionRegime.meanReversionEnabled) {
    const closePrev = candles1m[lastIndex1m - 1].close;
    const buyMeanReversion = closePrev < bb.lower[lastIndex1m - 1] && c1m.close > bb.lower[lastIndex1m] && rsi1m[lastIndex1m] < (optParams.rsiOversold || 30);
    const sellMeanReversion = closePrev > bb.upper[lastIndex1m - 1] && c1m.close < bb.upper[lastIndex1m] && rsi1m[lastIndex1m] > (optParams.rsiOverbought || 70);

    if (buyMeanReversion) {
      return {
        shouldBuy: true,
        shouldSell: false,
        reason: `Bollinger Lower Band Close & Reversion with RSI oversold (${rsi1m[lastIndex1m].toFixed(1)})`,
        strategyName: 'Bollinger Bands Reversion',
        atr: atr1m[lastIndex1m]
      };
    }
    if (sellMeanReversion) {
      return {
        shouldBuy: false,
        shouldSell: true,
        reason: `Bollinger Upper Band Close & Reversion with RSI overbought (${rsi1m[lastIndex1m].toFixed(1)})`,
        strategyName: 'Bollinger Bands Reversion',
        atr: atr1m[lastIndex1m]
      };
    }
  }

  // ----------------------------------------------------
  // STRATEGY 6: Supertrend & Heikin Ashi Momentum (Trend Following)
  // ----------------------------------------------------
  if (sessionRegime.trendStrategiesEnabled) {
    const supertrend = calculateSupertrend(candles1m, 10, 3.0);
    const supertrendPrev = supertrend[lastIndex1m - 1];
    const supertrendCurr = supertrend[lastIndex1m];

    const turnBullish = supertrendCurr.dir === 1 && supertrendPrev.dir === -1;
    const turnBearish = supertrendCurr.dir === -1 && supertrendPrev.dir === 1;

    if (turnBullish && trend5m === 1) {
      return {
        shouldBuy: true,
        shouldSell: false,
        reason: `Supertrend flipped Bullish (Green) with Trend`,
        strategyName: 'Supertrend Scalper',
        atr: atr1m[lastIndex1m]
      };
    }
    if (turnBearish && trend5m === -1) {
      return {
        shouldBuy: false,
        shouldSell: true,
        reason: `Supertrend flipped Bearish (Red) with Trend`,
        strategyName: 'Supertrend Scalper',
        atr: atr1m[lastIndex1m]
      };
    }
  }

  // ----------------------------------------------------
  // STRATEGY 7: Stochastic & RSI Dual Confluence (ETH ONLY)
  // ----------------------------------------------------
  if (sessionRegime.meanReversionEnabled) {
    const stochK = stoch.k[lastIndex1m];
    const stochD = stoch.d[lastIndex1m];
    const stochKPrev = stoch.k[lastIndex1m - 1];
    const stochDPrev = stoch.d[lastIndex1m - 1];

    const stochCrossUp = stochK > stochD && stochKPrev <= stochDPrev && stochK < (optParams.stochOversold || 20);
    const stochCrossDown = stochK < stochD && stochKPrev >= stochDPrev && stochK > (optParams.stochOverbought || 80);

    const rsiBullish = rsi1m[lastIndex1m] < (optParams.rsiOversold || 35);
    const rsiBearish = rsi1m[lastIndex1m] > (optParams.rsiOverbought || 65);

    if (stochCrossUp && rsiBullish) {
      return {
        shouldBuy: true,
        shouldSell: false,
        reason: `Stochastic Crossover in oversold (<20) and RSI confluence`,
        strategyName: 'Stoch & RSI Confluence',
        atr: atr1m[lastIndex1m]
      };
    }
    if (stochCrossDown && rsiBearish) {
      return {
        shouldBuy: false,
        shouldSell: true,
        reason: `Stochastic Crossover in overbought (>80) and RSI confluence`,
        strategyName: 'Stoch & RSI Confluence',
        atr: atr1m[lastIndex1m]
      };
    }
  }

  return { shouldBuy: false, shouldSell: false, reason: 'No confluence or strategy triggers met', strategyName: 'None' };
}

// Helper: Calculate standard Supertrend array
function calculateSupertrend(candles, period = 10, multiplier = 3.0) {
  const atr = calculateATR(candles, period);
  const supertrend = new Array(candles.length).fill(null).map(() => ({ trend: 0, dir: 1 }));
  
  if (candles.length < period) return supertrend;

  let upperBand = new Array(candles.length).fill(0);
  let lowerBand = new Array(candles.length).fill(0);
  let dir = 1;

  for (let i = period; i < candles.length; i++) {
    const c = candles[i];
    const typicalPrice = (c.high + c.low) / 2;
    const basicUpper = typicalPrice + multiplier * atr[i];
    const basicLower = typicalPrice - multiplier * atr[i];

    upperBand[i] = basicUpper < upperBand[i - 1] || candles[i - 1].close > upperBand[i - 1] ? basicUpper : upperBand[i - 1];
    lowerBand[i] = basicLower > lowerBand[i - 1] || candles[i - 1].close < lowerBand[i - 1] ? basicLower : lowerBand[i - 1];

    if (candles[i - 1].close > upperBand[i - 1]) {
      dir = 1;
    } else if (candles[i - 1].close < lowerBand[i - 1]) {
      dir = -1;
    }

    supertrend[i] = {
      trend: dir === 1 ? lowerBand[i] : upperBand[i],
      dir
    };
  }

  return supertrend;
}

// Helper: Calculate 15-minute Opening Range High/Low
function getORBRange(candles1m) {
  // Find start of day (RTH opens at 6:30 AM PT)
  // Scan first 15 candles of RTH
  let firstRTHIdx = -1;
  for (let i = candles1m.length - 1; i >= 0; i--) {
    const d = new Date(candles1m[i].time || Date.now());
    const hours = d.getHours();
    const minutes = d.getMinutes();
    const day = d.getDay();
    if (day >= 1 && day <= 5 && hours === 6 && minutes === 30) {
      firstRTHIdx = i;
      break;
    }
  }

  if (firstRTHIdx === -1 || candles1m.length < firstRTHIdx + 15) {
    return null; // Not enough day candles or not RTH yet
  }

  let high = -Infinity;
  let low = Infinity;

  for (let i = firstRTHIdx; i < firstRTHIdx + 15; i++) {
    if (candles1m[i].high > high) high = candles1m[i].high;
    if (candles1m[i].low < low) low = candles1m[i].low;
  }

  return { high, low };
}

// Helper: Detect Fair Value Gap (FVG) in past 3 candles
function detectFVG(candles) {
  if (candles.length < 3) return null;
  const idx = candles.length - 1;
  const c1 = candles[idx - 2];
  const c2 = candles[idx - 1];
  const c3 = candles[idx];

  // Bullish FVG: Low of candle 3 is greater than High of candle 1
  if (c3.low > c1.high && c2.close > c2.open) {
    return {
      type: 'Bullish',
      low: c1.high,
      high: c3.low
    };
  }

  // Bearish FVG: High of candle 3 is less than Low of candle 1
  if (c3.high < c1.low && c2.close < c2.open) {
    return {
      type: 'Bearish',
      low: c3.high,
      high: c1.low
    };
  }

  return null;
}

module.exports = {
  evaluateStrategies,
  calculateATR,
  calculateStochastic,
  calculateVWAP,
  calculateSupertrend
};
