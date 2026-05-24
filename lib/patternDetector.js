// Candlestick Pattern Detector Module
// Analyzes OHLCV data to classify candlestick patterns and structures

function detectCandlePatterns(candles) {
  if (!candles || candles.length < 3) {
    return { pattern: 'None', direction: 0 };
  }

  // Get the most recent candle (index 0 is current forming, index 1 is last closed)
  const current = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];

  const c_open = current.open;
  const c_high = current.high;
  const c_low = current.low;
  const c_close = current.close;

  const bodySize = Math.abs(c_close - c_open);
  const totalRange = c_high - c_low;

  if (totalRange === 0) return { pattern: 'None', direction: 0 };

  const upperShadow = c_high - Math.max(c_open, c_close);
  const lowerShadow = Math.min(c_open, c_close) - c_low;
  const isGreen = c_close >= c_open;

  // 1. DOJI (Indecision)
  // Body is less than 10% of total range
  if (bodySize / totalRange < 0.1) {
    return { pattern: 'Doji', direction: 0, text: 'Doji (Indecision)' };
  }

  // 2. HAMMER (Bullish Reversal)
  // Body in upper third, lower shadow is at least 2x body, tiny upper shadow
  if (lowerShadow > bodySize * 2 && upperShadow < bodySize * 0.5) {
    return { pattern: 'Hammer', direction: 1, text: 'Hammer (Bullish Reversal)' };
  }

  // 3. SHOOTING STAR (Bearish Reversal)
  // Body in lower third, upper shadow is at least 2x body, tiny lower shadow
  if (upperShadow > bodySize * 2 && lowerShadow < bodySize * 0.5) {
    return { pattern: 'ShootingStar', direction: -1, text: 'Shooting Star (Bearish Reversal)' };
  }

  // 4. BULLISH ENGULFING
  // Prev candle is red, current is green, and current body completely engulfs prev body
  if (!prev.isGreen && isGreen && c_open <= prev.close && c_close >= prev.open) {
    return { pattern: 'BullishEngulfing', direction: 1, text: 'Bullish Engulfing (Strong Buy)' };
  }

  // 5. BEARISH ENGULFING
  // Prev candle is green, current is red, and current body completely engulfs prev body
  if (prev.isGreen && !isGreen && c_open >= prev.close && c_close <= prev.open) {
    return { pattern: 'BearishEngulfing', direction: -1, text: 'Bearish Engulfing (Strong Sell)' };
  }

  // 6. MARUBOZU (Breakout Momentum)
  // Body is at least 90% of total range (no or tiny wicks)
  if (bodySize / totalRange > 0.9) {
    return {
      pattern: 'Marubozu',
      direction: isGreen ? 1 : -1,
      text: `${isGreen ? 'Bullish' : 'Bearish'} Marubozu (Breakout)`
    };
  }

  return { pattern: 'None', direction: 0 };
}

module.exports = {
  detectCandlePatterns
};
