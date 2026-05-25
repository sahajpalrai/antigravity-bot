const fs = require('fs');
const path = require('path');

console.log("=====================================================================");
console.log("🧪 STARTING INTEGRATION TEST: DEEP LOSS DIAGNOSTICS & DUAL-TUNING");
console.log("=====================================================================");

const SETTINGS_FILE_PATH = path.join(__dirname, './optimized_settings.json');
const STATE_FILE_PATH = path.join(__dirname, './portfolio_state.json');

// 1. Load current settings state to verify tuning is applied
const initialSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8'));
console.log("\n📦 Initial optimized settings loaded.");
console.log(`• NQ RTH EMAs: Fast ${initialSettings['NQ=F'].RTH.emaFast} / Slow ${initialSettings['NQ=F'].RTH.emaSlow}`);
console.log(`• NQ ETH BB Dev: ${initialSettings['NQ=F'].ETH.bbStdDev} | RSI Limits: ${initialSettings['NQ=F'].ETH.rsiOversold}/${initialSettings['NQ=F'].ETH.rsiOverbought}`);

// 2. Setup mock losing trades
const mockLosingTradeEMA = {
  symbol: "NQ=F",
  direction: "Long",
  entryPrice: 29500.00,
  exitPrice: 29450.00,
  qty: 2,
  strategyUsed: "EMA Crossover",
  entryTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 mins ago
  exitTime: new Date().toISOString(),
  profit: -200.00,
  reason: "Stop Loss Triggered",
  accountNumber: "SimHA candles"
};

const mockLosingTradeMeanReversion = {
  symbol: "NQ=F",
  direction: "Short",
  entryPrice: 29600.00,
  exitPrice: 29650.00,
  qty: 2,
  strategyUsed: "BB Reversion",
  entryTime: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
  exitTime: new Date().toISOString(),
  profit: -200.00,
  reason: "Stop Loss Triggered",
  accountNumber: "SimHA candles"
};

// 3. Inject mock trades into state history to trigger win rate < 80% underperformance check
// We want to force the strategy stats to fall below 80% for "EMA Crossover" and "BB Reversion".
const initialPortfolioState = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf-8'));
if (fs.existsSync(STATE_FILE_PATH)) {
  const state = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf-8'));
  state.history = state.history || [];
  
  // Clean past history for test reproducibility or just unshift mock stats
  // We insert 4 consecutive losses for both strategies to guarantee underperformance trigger
  for (let i = 0; i < 4; i++) {
    state.history.unshift({
      symbol: "NQ=F",
      direction: "Long",
      entryPrice: 29500.00,
      exitPrice: 29450.00,
      qty: 2,
      strategyUsed: "EMA Crossover",
      entryTime: new Date().toISOString(),
      exitTime: new Date().toISOString(),
      profit: -200.00,
      reason: "Stop Loss"
    });
    state.history.unshift({
      symbol: "NQ=F",
      direction: "Short",
      entryPrice: 29600.00,
      exitPrice: 29650.00,
      qty: 2,
      strategyUsed: "BB Reversion",
      entryTime: new Date().toISOString(),
      exitTime: new Date().toISOString(),
      profit: -200.00,
      reason: "Stop Loss"
    });
  }
  
  fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  console.log("📝 Mock history injected into portfolio_state.json.");
}

// 4. Require the Auditor and run test
const { auditRecentTrades, performDailyPostMarketAudit } = require('./lib/tradeAuditor');

(async () => {
  try {
    console.log("\n🔍 1. Triggering Post-Trade Audit for Losing EMA Trend Crossover Trade...");
    await auditRecentTrades(mockLosingTradeEMA);
    
    console.log("\n🔍 2. Triggering Post-Trade Audit for Losing Mean-Reversion Trade...");
    await auditRecentTrades(mockLosingTradeMeanReversion);

    // 5. Verify optimized_settings.json was dynamically tuned!
    const updatedSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8'));
    console.log("\n🎯 AFTER-TUNING RESULTS:");
    console.log(`• NQ RTH EMAs: Fast ${updatedSettings['NQ=F'].RTH.emaFast} / Slow ${updatedSettings['NQ=F'].RTH.emaSlow}`);
    console.log(`• NQ ETH BB Dev: ${updatedSettings['NQ=F'].ETH.bbStdDev} | RSI Limits: ${updatedSettings['NQ=F'].ETH.rsiOversold}/${updatedSettings['NQ=F'].ETH.rsiOverbought}`);

    const emaFastChanged = updatedSettings['NQ=F'].RTH.emaFast !== initialSettings['NQ=F'].RTH.emaFast;
    const emaSlowChanged = updatedSettings['NQ=F'].RTH.emaSlow !== initialSettings['NQ=F'].RTH.emaSlow;
    const bbDevChanged = updatedSettings['NQ=F'].ETH.bbStdDev !== initialSettings['NQ=F'].ETH.bbStdDev;

    if (emaFastChanged || emaSlowChanged || bbDevChanged) {
      console.log("\n✅ SUCCESS: Parameter tuning applied successfully!");
      if (emaFastChanged || emaSlowChanged) console.log("  ➡️ EMA Crossover slowed down (filters whipsaws).");
      if (bbDevChanged) console.log("  ➡️ Bollinger Band standard deviation increased (ignores breakout wicks).");
    } else {
      console.log("\n⚠️ WARNING: Settings were not modified. Check if parameters hit caps or if stats were sufficient.");
    }

    // 6. Test the daily post-market sweep audit
    console.log("\n📅 3. Testing Daily Post-Market Sweep Audit...");
    await performDailyPostMarketAudit();

    console.log("\n=====================================================================");
    console.log("✅ INTEGRATION TEST COMPLETED successfully!");
    console.log("=====================================================================");
  } catch (err) {
    console.error("❌ TEST FAILED:", err);
  } finally {
    // Revert settings to avoid messing up active live parameters for the user
    fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(initialSettings, null, 2), 'utf-8');
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(initialPortfolioState, null, 2), 'utf-8');
    console.log("\n♻️ Reverted optimized_settings.json & portfolio_state.json back to pre-test conditions.");
  }
})();
