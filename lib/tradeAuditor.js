const fs = require('fs');
const path = require('path');
const { sendTelegramMessage } = require('./telegram');
const { getPTDateTime } = require('./scheduleController');

const SETTINGS_FILE_PATH = path.join(__dirname, '../optimized_settings.json');
const STATE_FILE_PATH = path.join(__dirname, '../portfolio_state.json');

// Mathematical indicator solvers computed exactly at index of entry
function getEMAAtIndex(candles, index, period) {
  if (index < period - 1) return candles[index].close;
  const k = 2 / (period + 1);
  let ema = candles[0].close;
  for (let i = 1; i <= index; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
}

function getBollingerBandsAtIndex(candles, index, period, stdDevMultiplier) {
  const start = Math.max(0, index - period + 1);
  const count = index - start + 1;
  let sum = 0;
  for (let i = start; i <= index; i++) {
    sum += candles[i].close;
  }
  const sma = sum / count;
  let varianceSum = 0;
  for (let i = start; i <= index; i++) {
    varianceSum += Math.pow(candles[i].close - sma, 2);
  }
  const stdDev = Math.sqrt(varianceSum / count);
  return {
    middle: sma,
    upper: sma + stdDevMultiplier * stdDev,
    lower: sma - stdDevMultiplier * stdDev,
    bandwidth: sma > 0 ? (2 * stdDevMultiplier * stdDev) / sma : 0
  };
}

function getATRAtIndex(candles, index, period = 14) {
  if (index < 1) return 0;
  const start = Math.max(1, index - period + 1);
  const count = index - start + 1;
  let trSum = 0;
  for (let i = start; i <= index; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
    trSum += tr;
  }
  return trSum / count;
}

function getEMACrossoversCount(candles, index, fastPeriod = 9, slowPeriod = 21, lookback = 20) {
  const start = Math.max(slowPeriod, index - lookback);
  let crosses = 0;
  let prevDiff = 0;
  for (let i = start; i <= index; i++) {
    const fast = getEMAAtIndex(candles, i, fastPeriod);
    const slow = getEMAAtIndex(candles, i, slowPeriod);
    const diff = fast - slow;
    if (i > start && ((diff > 0 && prevDiff <= 0) || (diff < 0 && prevDiff >= 0))) {
      crosses++;
    }
    prevDiff = diff;
  }
  return crosses;
}

/**
 * Automatically audits trade history after every closed trade,
 * analyzes losing trades, and fine-tunes parameter ranges to ensure consistent profitability.
 */
async function auditRecentTrades(newClosedTrade) {
  console.log(`[TradeAuditor] Starting post-trade audit for symbol: ${newClosedTrade.symbol}...`);

  if (!fs.existsSync(STATE_FILE_PATH)) return;

  try {
    const portfolio = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf-8'));
    const history = portfolio.history || [];

    // Default indicators variables to fill out
    let diagnosis = 'Undetermined / Normal Volatility';
    let detailedReason = 'No clear structural traps detected at entry. Trade likely stopped out due to standard statistical noise.';
    let lossCategory = 'Noise';
    let priceAtEntry = newClosedTrade.entryPrice;
    let ema200 = 0;
    let atr = 0;
    let bandwidth = 0;

    const isLong = newClosedTrade.direction.toLowerCase() === 'long';
    const strat = newClosedTrade.strategyUsed || 'Unknown';

    // Proactively run deep diagnostics only if the trade closed at a loss!
    if (newClosedTrade.profit < 0) {
      try {
        const { fetchCandlesWithFallback } = require('./dataProvider');
        const candles = await fetchCandlesWithFallback(newClosedTrade.symbol, '5m', '5d');

        if (candles && candles.length >= 20) {
          const entryTimeMs = new Date(newClosedTrade.entryTime).getTime();
          let entryIndex = -1;
          let minDiff = Infinity;

          for (let i = 0; i < candles.length; i++) {
            const diff = Math.abs(new Date(candles[i].time).getTime() - entryTimeMs);
            if (diff < minDiff) {
              minDiff = diff;
              entryIndex = i;
            }
          }

          if (entryIndex !== -1 && entryIndex >= 20) {
            priceAtEntry = candles[entryIndex].close;
            ema200 = getEMAAtIndex(candles, entryIndex, 200);
            const ema50 = getEMAAtIndex(candles, entryIndex, 50);
            atr = getATRAtIndex(candles, entryIndex, 14);
            const bb = getBollingerBandsAtIndex(candles, entryIndex, 20, 2.0);
            bandwidth = bb.bandwidth;

            // Calculate historical average bandwidth
            let totalBw = 0;
            let bwCount = 0;
            const bwStart = Math.max(20, entryIndex - 20);
            for (let i = bwStart; i < entryIndex; i++) {
              totalBw += getBollingerBandsAtIndex(candles, i, 20, 2.0).bandwidth;
              bwCount++;
            }
            const avgPastBandwidth = bwCount > 0 ? totalBw / bwCount : bb.bandwidth;

            // Calculate average ATR of past 50 bars
            let totalAtr = 0;
            let atrCount = 0;
            const atrStart = Math.max(1, entryIndex - 50);
            for (let i = atrStart; i < entryIndex; i++) {
              totalAtr += getATRAtIndex(candles, i, 14);
              atrCount++;
            }
            const avgPastAtr = atrCount > 0 ? totalAtr / atrCount : atr;

            // Calculate crossovers frequency
            const crosses = getEMACrossoversCount(candles, entryIndex, 9, 21, 20);

            // Check slope of 200 EMA (over last 5 bars)
            const prevEma200 = getEMAAtIndex(candles, Math.max(0, entryIndex - 5), 200);
            const ema200Slope = ema200 - prevEma200;

            // 1. Against-Trend (Wrong-Directional Entry)
            const isTrendOpposed = (isLong && (priceAtEntry < ema200 || ema200Slope < -0.05)) || 
                                   (!isLong && (priceAtEntry > ema200 || ema200Slope > 0.05));
            
            if (isTrendOpposed && (strat.includes('EMA') || strat.includes('Cross') || strat.includes('Mirror') || strat.includes('Unknown'))) {
              diagnosis = 'Against-Trend (Wrong-Directional Entry)';
              detailedReason = `Entered a ${isLong ? 'Long' : 'Short'} trade while the 200 EMA trend was ${ema200Slope > 0 ? 'bullish' : 'bearish'} ($${ema200.toFixed(2)}) and price was ${isLong ? 'below' : 'above'} it ($${priceAtEntry.toFixed(2)}). Entry was taken against the primary trend direction.`;
              lossCategory = 'Wrong-Directional';
            }
            // 2. Breakout Trap (Counter-Trend Momentum Runaway)
            else if (bb.bandwidth > avgPastBandwidth * 1.25 && (strat.includes('BB') || strat.includes('Stoch') || strat.includes('RSI') || strat.includes('Reversion'))) {
              diagnosis = 'Breakout Trap (Counter-Trend Momentum Runaway)';
              detailedReason = `Attempted a mean-reversion counter-trend trade during a rapid volatility breakout. Bollinger Band Bandwidth had expanded by ${((bb.bandwidth / avgPastBandwidth - 1) * 100).toFixed(1)}% to ${(bb.bandwidth * 100).toFixed(2)}% compared to recent averages (${(avgPastBandwidth * 100).toFixed(2)}%). Price broke through the ${isLong ? 'lower' : 'upper'} band with high momentum rather than reverting.`;
              lossCategory = 'BreakoutTrap';
            }
            // 3. Chop Whipsaw (Flat Noise)
            else if ((crosses >= 3 || atr < avgPastAtr * 0.70) && (strat.includes('EMA') || strat.includes('Cross') || strat.includes('Mirror'))) {
              diagnosis = 'Chop Whipsaw (Flat/Range Consolidation Noise)';
              detailedReason = `Entered a trend crossover trade inside a flat, low-volatility consolidation zone. EMA crossover triggered ${crosses} times in the last 20 bars, indicating whipsawing price action. Volatility (ATR) was at $${atr.toFixed(2)}, which is ${((1 - atr / avgPastAtr) * 100).toFixed(1)}% below the recent average ($${avgPastAtr.toFixed(2)}%).`;
              lossCategory = 'ChopWhipsaw';
            }
            // 4. Volatility Squeeze Trap
            else if (bb.bandwidth < avgPastBandwidth * 0.70 && (strat.includes('BB') || strat.includes('Stoch') || strat.includes('RSI') || strat.includes('Reversion'))) {
              diagnosis = 'Volatility Squeeze Trap';
              detailedReason = `Attempted a mean-reversion trade inside an active Bollinger Band Squeeze channel (bandwidth ${(bb.bandwidth * 100).toFixed(2)}% is ${((1 - bb.bandwidth / avgPastBandwidth) * 100).toFixed(1)}% below average). Squeezes represent compression that usually resolves in massive breakouts, which quickly breached our stops.`;
              lossCategory = 'SqueezeTrap';
            }
          }
        }
      } catch (e) {
        console.error(`[TradeAuditor] Candle fetch or indicator math error:`, e.message);
        diagnosis = 'Diagnostic Error';
        detailedReason = `Could not fetch historical candle wicks: ${e.message}`;
      }
    }

    if (history.length < 5) {
      console.log(`[TradeAuditor] Insufficient trade records (${history.length}/5) for statistical performance audit.`);
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
    auditReport += `• Last Closed: *${newClosedTrade.symbol}* - *${newClosedTrade.strategyUsed}* (${newClosedTrade.profit >= 0 ? '🟢 +' : '🔴 '}$${newClosedTrade.profit.toFixed(2)})\n`;
    auditReport += `• Direction: *${newClosedTrade.direction}* | Exit Reason: *${newClosedTrade.reason}*\n\n`;

    if (newClosedTrade.profit < 0) {
      auditReport += `📊 *DEEP TECHNICAL DIAGNOSTICS* 📊\n`;
      auditReport += `• *Diagnosis:* ${diagnosis}\n`;
      auditReport += `• *Reason:* _${detailedReason}_\n`;
      auditReport += `• *Metrics at Entry:* Price $${priceAtEntry.toFixed(2)} | EMA200 $${ema200.toFixed(2)} | ATR $${atr.toFixed(2)} | Bandwidth ${(bandwidth * 100).toFixed(2)}%\n\n`;
    }

    // 2. Identify Underperforming Strategies (Win Rate < 80%) & Under-Trading Strategies
    const underperformingList = [];
    const underTradingList = [];
    for (const [stratName, stats] of Object.entries(strategyStats)) {
      const winRate = (stats.wins / stats.total) * 100;
      if (stats.total >= 3) {
        if (winRate < 80) {
          underperformingList.push({ name: stratName, winRate, total: stats.total, net: stats.netProfit, wins: stats.wins });
        } else if (stats.total < 4) {
          underTradingList.push({ name: stratName, winRate, total: stats.total, net: stats.netProfit });
        }
      }
    }

    // 3. Self-Healing Optimization & Parameter Tuning Binders
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8'));

      // Case A: Strategy underperforming (Win Rate < 80%) -> Tighten filters to protect capital and boost quality
      if (underperformingList.length > 0) {
        underperformingList.forEach(uStrat => {
          auditReport += `⚠️ *UNDERPERFORMANCE ALERT (Target < 80%)* ⚠️\n`;
          auditReport += `• Strategy: *${uStrat.name}*\n`;
          auditReport += `• Win Rate: *${uStrat.winRate.toFixed(1)}%* (${uStrat.wins}/${uStrat.total} trades)\n`;
          auditReport += `• Net Return: *$${uStrat.net.toFixed(2)}*\n`;
          auditReport += `• Action: *Tightening filters to hit 80%+ profitability target...*\n\n`;

          // Apply contract-level parameter adjustments based on specific strategy models
          if (uStrat.name.includes('BB') || uStrat.name.includes('Stoch') || uStrat.name.includes('RSI') || uStrat.name.includes('Reversion')) {
            // ETH Session: Increase BB standard deviation, tighten RSI Limits
            for (const sym of ['NQ=F', 'ES=F', 'CL=F', 'GC=F']) {
              if (settings[sym] && settings[sym].ETH) {
                const prevDev = settings[sym].ETH.bbStdDev || 2.0;
                let increment = 0.10;
                if (lossCategory === 'BreakoutTrap') increment = 0.15; // Aggressively block breakout traps
                const newDev = parseFloat((prevDev + increment).toFixed(2));
                
                if (newDev <= 2.4) {
                  settings[sym].ETH.bbStdDev = newDev;
                  tuningApplied = true;
                  auditReport += `⚙️ Tightened *${sym} BB Dev* ➡️ *${newDev}* (Requires extreme wicks)\n`;
                }

                // Tighten RSI oversold/overbought thresholds to prevent buying early
                const prevOS = settings[sym].ETH.rsiOversold || 30;
                const prevOB = settings[sym].ETH.rsiOverbought || 70;
                const newOS = Math.max(25, prevOS - 2);
                const newOB = Math.min(75, prevOB + 2);

                settings[sym].ETH.rsiOversold = newOS;
                settings[sym].ETH.rsiOverbought = newOB;
                tuningApplied = true;
                auditReport += `⚙️ Tightened *${sym} RSI Limits* ➡️ *${newOS} / ${newOB}* (Ignores noise range)\n`;
              }
            }
          } 
          else if (uStrat.name.includes('EMA') || uStrat.name.includes('Cross') || uStrat.name.includes('Mirror') || uStrat.name.includes('Unknown')) {
            // RTH Session: Slow down EMA periods to filter out choppy crossovers
            for (const sym of ['NQ=F', 'ES=F', 'CL=F', 'GC=F']) {
              if (settings[sym] && settings[sym].RTH) {
                const prevFast = settings[sym].RTH.emaFast || 8;
                const prevSlow = settings[sym].RTH.emaSlow || 20;
                let fastIncrement = 1;
                let slowIncrement = 2;

                if (lossCategory === 'ChopWhipsaw') {
                  fastIncrement = 1;
                  slowIncrement = 3;
                }

                const newFast = prevFast + fastIncrement;
                const newSlow = prevSlow + slowIncrement;

                if (newSlow <= 28) {
                  settings[sym].RTH.emaFast = newFast;
                  settings[sym].RTH.emaSlow = newSlow;
                  tuningApplied = true;
                  auditReport += `⚙️ Slowed *${sym} EMAs* ➡️ *${newFast} / ${newSlow}* (Smooths whipsaws)\n`;
                }
              }
            }
          }
        });
      }

      // Case B: Strategy highly profitable (>= 80%) but under-trading -> Loosen filters to capture max trade volume
      if (underTradingList.length > 0) {
        underTradingList.forEach(uTrade => {
          auditReport += `🚀 *FREQUENCY OPTIMIZATION ALERT (Win Rate >= 80% but Trades < 4)* 🚀\n`;
          auditReport += `• Strategy: *${uTrade.name}*\n`;
          auditReport += `• Win Rate: *${uTrade.winRate.toFixed(1)}%* (Perfect quality)\n`;
          auditReport += `• Action: *Loosening filters slightly to maximize trade frequency...*\n\n`;

          if (uTrade.name.includes('BB') || uTrade.name.includes('Stoch') || uTrade.name.includes('RSI') || uTrade.name.includes('Reversion')) {
            // ETH Session: Loosen BB Dev and relax RSI Limits to increase trade count
            for (const sym of ['NQ=F', 'ES=F', 'CL=F', 'GC=F']) {
              if (settings[sym] && settings[sym].ETH) {
                const prevDev = settings[sym].ETH.bbStdDev || 2.0;
                const newDev = parseFloat((prevDev - 0.05).toFixed(2));
                
                if (newDev >= 1.6) {
                  settings[sym].ETH.bbStdDev = newDev;
                  tuningApplied = true;
                  auditReport += `⚙️ Relaxed *${sym} BB Dev* from ${prevDev} ➡️ *${newDev}* (Increases entries)\n`;
                }

                const prevOS = settings[sym].ETH.rsiOversold || 30;
                const prevOB = settings[sym].ETH.rsiOverbought || 70;
                const newOS = Math.min(33, prevOS + 1);
                const newOB = Math.max(67, prevOB - 1);

                settings[sym].ETH.rsiOversold = newOS;
                settings[sym].ETH.rsiOverbought = newOB;
                tuningApplied = true;
                auditReport += `⚙️ Relaxed *${sym} RSI Limits* ➡️ *${newOS} / ${newOB}*\n`;
              }
            }
          }
          else if (uTrade.name.includes('EMA') || uTrade.name.includes('Cross') || uTrade.name.includes('Mirror') || uTrade.name.includes('Unknown')) {
            // RTH Session: Speed up EMA crossover to trigger trends sooner
            for (const sym of ['NQ=F', 'ES=F', 'CL=F', 'GC=F']) {
              if (settings[sym] && settings[sym].RTH) {
                const prevFast = settings[sym].RTH.emaFast || 9;
                const prevSlow = settings[sym].RTH.emaSlow || 21;
                const newFast = Math.max(7, prevFast - 1);
                const newSlow = Math.max(18, prevSlow - 1);

                if (newFast !== prevFast || newSlow !== prevSlow) {
                  settings[sym].RTH.emaFast = newFast;
                  settings[sym].RTH.emaSlow = newSlow;
                  tuningApplied = true;
                  auditReport += `⚙️ Speeded *${sym} EMAs* ➡️ *${newFast} / ${newSlow}* (Increases crossover responsiveness)\n`;
                }
              }
            }
          }
        });
      }

      if (tuningApplied) {
        fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(settings, null, 2), 'utf-8');
        console.log('[TradeAuditor] Strategy settings tuned and persisted.');
        
        // Broadcast the newly optimized parameters to connected NinjaTrader clients over TCP!
        try {
          const { broadcastParamsToNT8 } = require('./nt8Bridge');
          broadcastParamsToNT8();
          auditReport += `\n🤖 *Self-Healing complete!* New optimized parameters successfully compiled and hot-reloaded to connected NinjaTrader 8 charts.`;
        } catch (err) {
          console.error('[TradeAuditor] Failed to broadcast parameters:', err.message);
        }
      }
    }

    sendTelegramMessage(auditReport);
  } catch (err) {
    console.error('[TradeAuditor] Execution error:', err.message);
  }
}

/**
 * Sweeps the entire day's trades post-market, diagnoses all losses,
 * and posts a beautiful detailed report to Telegram.
 */
async function performDailyPostMarketAudit(hour = null) {
  console.log(`[TradeAuditor] Running daily post-market sweep...`);
  if (!fs.existsSync(STATE_FILE_PATH)) return;

  try {
    const portfolio = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf-8'));
    const history = portfolio.history || [];

    // Filter trades closed in the last 24 hours
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const todayTrades = history.filter(t => new Date(t.exitTime).getTime() >= oneDayAgo);
    const pt = getPTDateTime();

    let sessionLabel = "Post-Market Daily Sweep";
    if (hour === 2) sessionLabel = "Overnight ETH Session (2:00 AM PT)";
    else if (hour === 8) sessionLabel = "Morning US RTH Session (8:00 AM PT)";
    else if (hour === 12) sessionLabel = "Midday US RTH Session (12:00 PM PT)";
    else if (hour === 18) sessionLabel = "Post-Market Daily Sweep (6:00 PM PT)";

    if (todayTrades.length === 0) {
      console.log(`[TradeAuditor] No trades recorded in the last 24 hours. Daily sweep complete.`);
      sendTelegramMessage(`📅 *${sessionLabel.toUpperCase()}* 📅\nDate: *${pt.dateStr}*\n• Total Trades Today: *0*\n• Status: *Flat, no actions taken.*`);
      return;
    }

    let totalProfit = 0;
    let wins = 0;
    let losses = 0;
    const lossesList = [];

    todayTrades.forEach(t => {
      totalProfit += t.profit;
      if (t.profit > 0) wins++;
      else {
        losses++;
        lossesList.push(t);
      }
    });

    const winRate = (wins / todayTrades.length) * 100;

    let report = `📅 *${sessionLabel.toUpperCase()}* 📅\n`;
    report += `Date: *${pt.dateStr}* | Time: *${pt.timeStr}*\n\n`;
    report += `📈 *Daily Summary:* \n`;
    report += `• Total Trades: *${todayTrades.length}*\n`;
    report += `• P&L: *${totalProfit >= 0 ? '🟢 +' : '🔴 '}$${totalProfit.toFixed(2)}*\n`;
    report += `• Win Rate: *${winRate.toFixed(1)}%* (${wins}W / ${losses}L)\n\n`;

    if (lossesList.length > 0) {
      report += `⚠️ *Losing Trade Audits:* \n`;
      for (const lt of lossesList) {
        report += `• *${lt.symbol}* (${lt.strategyUsed}): -$${Math.abs(lt.profit).toFixed(2)}\n`;
        
        // Fetch candle diagnostic
        try {
          const { fetchCandlesWithFallback } = require('./dataProvider');
          const candles = await fetchCandlesWithFallback(lt.symbol, '5m', '5d');
          if (candles && candles.length >= 20) {
            const entryTimeMs = new Date(lt.entryTime).getTime();
            let entryIndex = -1;
            let minDiff = Infinity;
            
            for (let i = 0; i < candles.length; i++) {
              const diff = Math.abs(new Date(candles[i].time).getTime() - entryTimeMs);
              if (diff < minDiff) {
                minDiff = diff;
                entryIndex = i;
              }
            }

            if (entryIndex !== -1 && entryIndex >= 20) {
              const priceAtEntry = candles[entryIndex].close;
              const ema200 = getEMAAtIndex(candles, entryIndex, 200);
              const atr = getATRAtIndex(candles, entryIndex, 14);
              const bb = getBollingerBandsAtIndex(candles, entryIndex, 20, 2.0);
              
              let totalBw = 0;
              let bwCount = 0;
              const bwStart = Math.max(20, entryIndex - 20);
              for (let i = bwStart; i < entryIndex; i++) {
                totalBw += getBollingerBandsAtIndex(candles, i, 20, 2.0).bandwidth;
                bwCount++;
              }
              const avgPastBandwidth = bwCount > 0 ? totalBw / bwCount : bb.bandwidth;
              
              const crosses = getEMACrossoversCount(candles, entryIndex, 9, 21, 20);
              const prevEma200 = getEMAAtIndex(candles, Math.max(0, entryIndex - 5), 200);
              const ema200Slope = ema200 - prevEma200;

              const isLong = lt.direction.toLowerCase() === 'long';
              const strat = lt.strategyUsed || '';

              let diag = 'Noise';
              let cause = 'Standard statistical noise';

              const isTrendOpposed = (isLong && (priceAtEntry < ema200 || ema200Slope < -0.05)) || 
                                     (!isLong && (priceAtEntry > ema200 || ema200Slope > 0.05));
              
              if (isTrendOpposed && (strat.includes('EMA') || strat.includes('Cross') || strat.includes('Mirror') || strat.includes('Unknown'))) {
                diag = 'Against-Trend (Wrong-Directional)';
                cause = 'Counter-trend entry below/above the 200 EMA trend line.';
              } else if (bb.bandwidth > avgPastBandwidth * 1.25 && (strat.includes('BB') || strat.includes('Stoch') || strat.includes('RSI') || strat.includes('Reversion'))) {
                diag = 'Breakout Trap';
                cause = 'Mean-reversion entered during rapid volatility expansion.';
              } else if (crosses >= 3 && (strat.includes('EMA') || strat.includes('Cross') || strat.includes('Mirror'))) {
                diag = 'Chop Whipsaw';
                cause = 'Trend follow entered inside flat range consolidation.';
              } else if (bb.bandwidth < avgPastBandwidth * 0.70 && (strat.includes('BB') || strat.includes('Stoch') || strat.includes('RSI') || strat.includes('Reversion'))) {
                diag = 'Squeeze Trap';
                cause = 'Mean-reversion entered inside narrow volatility squeeze before breakout.';
              }

              report += `  - *Diagnosis:* ${diag}\n`;
              report += `  - *Cause:* _${cause}_\n`;
            }
          }
        } catch (e) {
          report += `  - *Diagnosis:* Failed to fetch diagnostic candles: ${e.message}\n`;
        }
      }
    } else {
      report += `🎉 *Perfect Day!* No losing trades recorded today. All executions closed profitable.`;
    }

    sendTelegramMessage(report);
    console.log(`[TradeAuditor] Daily post-market audit sweep completed! Report sent to Telegram.`);
  } catch (err) {
    console.error(`[TradeAuditor] Daily post-market sweep error:`, err.message);
  }
}

let activeSchedulerTimer = null;
let lastAuditedDateStr = '';

function startPostMarketAuditorScheduler() {
  if (activeSchedulerTimer) {
    console.log('[TradeAuditor] Post-market auditor scheduler is already running.');
    return;
  }

  console.log('[TradeAuditor] Timezone-aware Daily Post-Market Auditor Scheduler initialized in America/Los_Angeles PT.');
  
  const pt = getPTDateTime();
  console.log(`[TradeAuditor] Current local PT time: ${pt.dateStr} ${pt.timeStr}. Scheduler active.`);

  activeSchedulerTimer = setInterval(async () => {
    try {
      const ptNow = getPTDateTime();
      const { dateStr, day, hours, minutes } = ptNow;

      // Check if it is one of our target hours: 2:00 AM, 8:00 AM, 12:00 PM, 6:00 PM PT
      const targetHours = [2, 8, 12, 18];
      if (targetHours.includes(hours) && minutes === 0) {
        // 1. Only run on weekdays (Monday - Friday)
        const isWeekday = day >= 1 && day <= 5;
        if (!isWeekday) return;

        // 2. Prevent double triggers in the same hour
        const auditKey = `${dateStr}-${hours}`;
        if (lastAuditedDateStr === auditKey) {
          return;
        }

        // Mark as audited today at this hour and run the job
        lastAuditedDateStr = auditKey;
        await performDailyPostMarketAudit(hours);
      }
    } catch (err) {
      console.error('[TradeAuditor] Error inside post-market scheduler loop:', err.message);
    }
  }, 30000); // Check every 30 seconds
}

module.exports = {
  auditRecentTrades,
  performDailyPostMarketAudit,
  startPostMarketAuditorScheduler
};
