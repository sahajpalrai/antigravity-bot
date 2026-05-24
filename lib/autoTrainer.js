const { getPTDateTime } = require('./scheduleController');
const { fetchCandlesWithFallback } = require('./dataProvider');
const { runWalkforwardOptimization } = require('./mlOptimizer');
const { sendTelegramMessage } = require('./telegram');

// List of US Holidays to skip morning optimization
const US_HOLIDAYS = [
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-04', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'
];

let lastOptimizedDateStr = '';
let activeSchedulerTimer = null;

// The main daily optimization job
async function performDailyOptimization() {
  const pt = getPTDateTime();
  console.log(`\n================================================================`);
  console.log(`🧠 [AutoTrainer] Triggered Daily Walkforward Optimization at ${pt.dateStr} ${pt.timeStr}`);
  console.log(`================================================================\n`);

  let report = `☀️ *Morning ML Parameter Optimization Completed*\n`;
  report += `📅 Date: ${pt.dateStr} | Time: 6:00 AM PT (30m to Open)\n\n`;

  const symbols = ['NQ=F', 'ES=F', 'CL=F', 'GC=F'];
  const regimes = ['RTH', 'ETH'];
  let successCount = 0;

  for (const sym of symbols) {
    try {
      report += `*${sym}:*\n`;
      // Fetch 30 days of 5m candles ( Tastytrade-first fallback to Yahoo Finance )
      const candles = await fetchCandlesWithFallback(sym, '5m', '1mo');
      
      if (!candles || candles.length < 50) {
        console.error(`[AutoTrainer] Insufficient data to optimize for ${sym}`);
        report += `  ❌ Failed to download historical data.\n`;
        continue;
      }

      for (const reg of regimes) {
        const params = runWalkforwardOptimization(sym, candles, reg);
        report += `  • \`${reg}\` Mode: ${JSON.stringify(params)}\n`;
      }
      successCount++;
    } catch (err) {
      console.error(`[AutoTrainer] Failed to run optimization for ${sym}:`, err.message);
      report += `  ❌ Error during optimization: ${err.message}\n`;
    }
    report += '\n';
  }

  report += `🚀 *Bot active & primed with optimized settings for the opening bell!*`;

  // Send Telegram notification
  if (successCount > 0) {
    await sendTelegramMessage(report);
    console.log(`[AutoTrainer] Daily morning optimization completed successfully! Notification sent.`);
  } else {
    await sendTelegramMessage(`⚠️ *Daily Morning Optimization Warning*\nAll symbol parameter optimizations failed. Relying on default parameters.`);
    console.error(`[AutoTrainer] All symbol parameter optimizations failed.`);
  }
}

// Start the timezone-aware monitoring loop checking every 30 seconds
function startAutoTrainerScheduler() {
  if (activeSchedulerTimer) {
    console.log('[AutoTrainer] Scheduler is already running.');
    return;
  }

  console.log('[AutoTrainer] Timezone-aware Daily Scheduler initialized in America/Los_Angeles PT.');
  
  // Calculate next run target to print a human-readable log
  const pt = getPTDateTime();
  console.log(`[AutoTrainer] Current local PT time: ${pt.dateStr} ${pt.timeStr}. Scheduler active.`);

  activeSchedulerTimer = setInterval(async () => {
    try {
      const ptNow = getPTDateTime();
      const { dateStr, day, hours, minutes } = ptNow;

      // Check if it is 6:00 AM PT
      if (hours === 6 && minutes === 0) {
        // 1. Only run on weekdays (Monday - Friday)
        const isWeekday = day >= 1 && day <= 5;
        if (!isWeekday) return;

        // 2. Check if today is a scheduled US Holiday
        if (US_HOLIDAYS.includes(dateStr)) {
          console.log(`[AutoTrainer] 6:00 AM PT Holiday Halt: Skipping optimization today (${dateStr} - Holiday).`);
          return;
        }

        // 3. Prevent double triggers in the same minute
        if (lastOptimizedDateStr === dateStr) {
          return;
        }

        // Mark as optimized today and run the job
        lastOptimizedDateStr = dateStr;
        await performDailyOptimization();
      }
    } catch (err) {
      console.error('[AutoTrainer] Error inside scheduler ticking loop:', err.message);
    }
  }, 30000); // Check every 30 seconds
}

module.exports = {
  startAutoTrainerScheduler,
  performDailyOptimization
};
