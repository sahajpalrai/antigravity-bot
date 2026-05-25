const fs = require('fs');
const path = require('path');
const { sendTelegramMessage } = require('./telegram');

const SETTINGS_FILE_PATH = path.join(__dirname, '../optimized_settings.json');
const STATE_FILE_PATH = path.join(__dirname, '../portfolio_state.json');

/**
 * Automatically audits trade history after every closed trade,
 * analyzes losing trades, and fine-tunes parameter ranges to ensure consistent profitability.
 */
function auditRecentTrades(newClosedTrade) {
  console.log(`[TradeAuditor] Starting post-trade audit for symbol: ${newClosedTrade.symbol}...`);

  if (!fs.existsSync(STATE_FILE_PATH)) return;

  try {
    const portfolio = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf-8'));
    const history = portfolio.history || [];

    if (history.length < 5) {
      console.log(`[TradeAuditor] Insufficient trade records (${history.length}/5) for statistical audit.`);
      return;
    }

    // 1. Calculate Performance Stats per Strategy (last 30 trades)
    const recentTrades = history.slice(0, 30);
    const strategyStats = {};

    recentTrades.forEach(t => {
      const name = t.strategyUsed || 'Unknown';
      if (!strategyStats[name]) {
        strategyStats[name] = { total: 0, wins: 0, losses: 0, netProfit: 0 };
      }
      strategyStats[name].total += 1;
      if (t.profit > 0) {
        strategyStats[name].wins += 1;
      } else {
        strategyStats[name].losses += 1;
      }
      strategyStats[name].netProfit += t.profit;
    });

    console.log('[TradeAuditor] Strategy Performance Audited:', strategyStats);

    let tuningApplied = false;
    let auditReport = `🔍 *TACTICAL BOT AUDIT REPORT* 🔍\n`;
    auditReport += `• Last Closed: ${newClosedTrade.symbol} - ${newClosedTrade.strategyUsed} (${newClosedTrade.profit >= 0 ? '+' : ''}$${newClosedTrade.profit.toFixed(2)})\n\n`;

    // 2. Identify Underperforming Strategies (Win Rate < 45% with at least 3 trades)
    const underperformingList = [];
    for (const [strat, stats] of Object.entries(strategyStats)) {
      const winRate = (stats.wins / stats.total) * 100;
      if (stats.total >= 3 && winRate < 45) {
        underperformingList.push({ name: strat, winRate, total: stats.total, net: stats.netProfit });
      }
    }

    if (underperformingList.length === 0) {
      console.log('[TradeAuditor] All active strategies are performing within healthy profitable bands.');
      return;
    }

    // 3. Self-Healing Optimization & Parameter Tuning Binders
    // If a strategy is losing, we automatically tighten its filters in optimized_settings.json
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8'));

      underperformingList.forEach(strat => {
        auditReport += `⚠️ *UNDERPERFORMANCE ALERT* ⚠️\n`;
        auditReport += `• Strategy: *${strat.name}*\n`;
        auditReport += `• Win Rate: *${strat.winRate.toFixed(1)}%* (${strat.wins}/${strat.total} trades)\n`;
        auditReport += `• Net Return: *$${strat.net.toFixed(2)}*\n`;
        auditReport += `• Action: *Tightening entry wicks and filters...*\n\n`;

        // Apply contract-level parameter adjustments based on specific strategy models
        if (strat.name === 'BB Reversion' || strat.name === 'Bollinger Bands Reversion') {
          // Increase Bollinger Band deviation to ignore noise and enter only on extreme extremes
          for (const sym of ['NQ=F', 'ES=F', 'CL=F', 'GC=F']) {
            if (settings[sym] && settings[sym].ETH) {
              const prevDev = settings[sym].ETH.bbStdDev || 2.0;
              const newDev = parseFloat((prevDev + 0.15).toFixed(2));
              if (newDev <= 2.6) {
                settings[sym].ETH.bbStdDev = newDev;
                tuningApplied = true;
                auditReport += `⚙️ Adjusted *${sym} BB Dev* from ${prevDev} ➡️ *${newDev}* (Filters noise)\n`;
              }
            }
          }
        } 
        else if (strat.name === 'Stoch & RSI' || strat.name === 'Stoch & RSI Confluence') {
          // Tighten RSI oversold/overbought thresholds to prevent buying early
          for (const sym of ['NQ=F', 'ES=F', 'CL=F', 'GC=F']) {
            if (settings[sym] && settings[sym].ETH) {
              const prevOS = settings[sym].ETH.rsiOversold || 35;
              const prevOB = settings[sym].ETH.rsiOverbought || 65;
              const newOS = Math.max(25, prevOS - 3);
              const newOB = Math.min(75, prevOB + 3);

              settings[sym].ETH.rsiOversold = newOS;
              settings[sym].ETH.rsiOverbought = newOB;
              tuningApplied = true;
              
              auditReport += `⚙️ Adjusted *${sym} RSI Limits* ➡️ *${newOS} / ${newOB}* (Tightens filters)\n`;
            }
          }
        }
        else if (strat.name === 'EMA Crossover') {
          // Slow down EMA periods to filter out choppy/flat whipsaws
          for (const sym of ['NQ=F', 'ES=F', 'CL=F', 'GC=F']) {
            if (settings[sym] && settings[sym].RTH) {
              const prevFast = settings[sym].RTH.emaFast || 9;
              const prevSlow = settings[sym].RTH.emaSlow || 21;
              const newFast = prevFast + 1;
              const newSlow = prevSlow + 2;

              if (newSlow <= 30) {
                settings[sym].RTH.emaFast = newFast;
                settings[sym].RTH.emaSlow = newSlow;
                tuningApplied = true;
                auditReport += `⚙️ Adjusted *${sym} EMAs* ➡️ *${newFast} / ${newSlow}* (Smooths whipsaws)\n`;
              }
            }
          }
        }
      });

      if (tuningApplied) {
        fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(settings, null, 2), 'utf-8');
        console.log('[TradeAuditor] Underperforming settings tuned and persisted.');
        
        // Broadcast the newly optimized parameters to connected NinjaTrader clients over TCP!
        const { broadcastParamsToNT8 } = require('./nt8Bridge');
        broadcastParamsToNT8();
        
        auditReport += `\n🤖 *Self-Healing complete!* New optimized parameters successfully compiled and hot-reloaded to connected NinjaTrader 8 charts.`;
        sendTelegramMessage(auditReport);
      }
    }
  } catch (err) {
    console.error('[TradeAuditor] Execution error:', err.message);
  }
}

module.exports = {
  auditRecentTrades
};
