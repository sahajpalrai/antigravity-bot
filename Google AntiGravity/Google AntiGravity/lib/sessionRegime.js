const { getPTDateTime } = require('./scheduleController');

// Define parameters for RTH and ETH sessions
const REGIMES = {
  RTH: {
    name: 'RTH (Regular Trading Hours)',
    trendStrategiesEnabled: true,
    meanReversionEnabled: false,
    atrStopMultiplier: 2.0,      // Wider stop-loss to survive noise
    atrTargetMultiplier: 3.0,    // Large target to catch extensions
    atrBreakevenMultiplier: 1.2, // Move to BE after a clean trend push
    atrTrailingMultiplier: 1.5   // Trail swing pivots loosely
  },
  ETH: {
    name: 'ETH (Electronic Trading Hours)',
    trendStrategiesEnabled: false, // Avoid getting chopped in horizontal ranges
    meanReversionEnabled: true,   // Focus on mean reversion and channel support/resistance
    atrStopMultiplier: 1.0,      // Tight stop out on breakout
    atrTargetMultiplier: 1.4,    // Small fast profit target
    atrBreakevenMultiplier: 0.6, // Move to BE quickly in choppy ranges
    atrTrailingMultiplier: 0.8   // Close trailing stops
  }
};

let currentRegimeName = 'ETH';

function getActiveSessionRegime() {
  const pt = getPTDateTime();
  const { hours, minutes } = pt;

  // RTH: Monday to Friday, 6:30 AM to 1:00 PM PT (9:30 AM to 4:00 PM ET)
  const isWeekday = pt.day >= 1 && pt.day <= 5;
  const minutesSinceMidnight = hours * 60 + minutes;
  const rthStartMinutes = 6 * 60 + 30; // 6:30 AM
  const rthEndMinutes = 13 * 60;        // 1:00 PM

  let regime = 'ETH';
  if (isWeekday && minutesSinceMidnight >= rthStartMinutes && minutesSinceMidnight < rthEndMinutes) {
    regime = 'RTH';
  }

  // Check if session changed to trigger logs
  if (regime !== currentRegimeName) {
    console.log(`[SessionRegime] Session changed from ${currentRegimeName} to ${regime}`);
    currentRegimeName = regime;
  }

  return {
    code: regime,
    ...REGIMES[regime],
    currentTimePT: `${pt.dateStr} ${pt.timeStr}`
  };
}

module.exports = {
  getActiveSessionRegime
};
