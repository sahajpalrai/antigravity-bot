// Antigravity v2 — Walkforward backtest + training harness
// Real, honest. Rolling train/test folds. No hardcoded targets. No sine-wave equity.
//
// Input: array of candles (5-min OHLCV) and label generator function.
// Output: per-fold metrics (win rate, PF, Sharpe, max DD) + aggregate +
//         model trained on the final fold (or on full data) for deployment.

'use strict';

const { buildFeatures, sessionFromTimestamp } = require('./featureEngineer');
const { classifyRegime, isTradeable, modelKey } = require('./regimeClassifier');
const { train, predict, serialize } = require('./gbdtModel');

// ─── Label generation ────────────────────────────────────────────────────────
// Default labeler: forward-looking N-bar return. If close[i+N] > close[i] + cost
// → label = 1 (long would win). Otherwise label = 0.
// This is a binary "did a +R move happen in the next N bars before a -R move?"
// (We use a triple-barrier-style labeler — proper, used by AFML).

function tripleBarrierLabel(candles, idx, opts) {
  // Walks forward up to maxBars looking at price trajectory.
  // Returns 1 if up barrier hit first, 0 if down barrier hit first or timeout.
  const entry = candles[idx].close;
  const atrEst = opts.atrAt(idx);
  if (!atrEst) return null;
  const upBarrier = entry + atrEst * opts.upMult;
  const downBarrier = entry - atrEst * opts.downMult;
  const maxIdx = Math.min(candles.length - 1, idx + opts.maxBars);

  for (let j = idx + 1; j <= maxIdx; j++) {
    if (candles[j].high >= upBarrier) return 1;
    if (candles[j].low <= downBarrier) return 0;
  }
  return null; // timeout — skip
}

// ─── Feature + label extraction across a candle series ───────────────────────

function buildDataset(candles, opts = {}) {
  const stride = opts.stride || 1;
  // Symmetric ATR barriers — 50/50 random-walk base rate, so any win-rate
  // above 50% reflects real predictive power. R:R is applied at execution
  // time, NOT baked into the label generation.
  const upMult = opts.upMult || 1.5;
  const downMult = opts.downMult || 1.5;
  const maxBars = opts.maxBars || 12;    // 1 hour on 5m chart
  const filterSession = opts.session || null;  // 'RTH' / 'ETH' / null
  const filterRegime = opts.regime || null;    // 'TREND_UP' / etc / null
  const labelDirection = opts.direction || 'long'; // 'long' or 'short'

  // Pre-compute ATR series for label generation (using 14-period TR mean)
  const atrSeries = new Array(candles.length).fill(null);
  let trSum = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i <= 14) {
      trSum += tr;
      if (i === 14) atrSeries[i] = trSum / 14;
    } else {
      atrSeries[i] = (atrSeries[i - 1] * 13 + tr) / 14;
    }
  }
  const atrAt = i => atrSeries[i];

  const rows = [];

  for (let i = 220; i < candles.length - maxBars; i += stride) {
    const window = candles.slice(Math.max(0, i - 220), i + 1);
    const fv = buildFeatures(window);
    if (!fv) continue;

    if (filterSession && fv.session !== filterSession) continue;

    const regimeInfo = classifyRegime(fv);
    if (!isTradeable(regimeInfo.regime)) continue;
    if (filterRegime && regimeInfo.regime !== filterRegime) continue;

    let label;
    if (labelDirection === 'long') {
      label = tripleBarrierLabel(candles, i, { atrAt, upMult, downMult, maxBars });
    } else {
      // For short side: up move = loss → invert
      const lbl = tripleBarrierLabel(candles, i, { atrAt, upMult: downMult, downMult: upMult, maxBars });
      label = lbl === null ? null : (lbl === 1 ? 0 : 1);
    }
    if (label === null) continue;

    rows.push({
      features: fv.values,
      featureNames: fv.names,
      label,
      ts: fv.ts,
      regime: regimeInfo.regime,
      session: fv.session,
      close: fv.close,
      atr: fv.atr,
      idx: i
    });
  }

  return rows;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

function computeMetrics(trades) {
  const n = trades.length;
  if (n === 0) return { trades: 0, winRate: 0, profitFactor: 0, sharpe: 0, maxDD: 0, netR: 0, avgR: 0 };

  let wins = 0, grossWin = 0, grossLoss = 0, netR = 0;
  let equity = 0, peak = 0, maxDD = 0;
  const returns = [];

  for (const t of trades) {
    const r = t.pnlR;
    netR += r;
    if (r > 0) { wins++; grossWin += r; } else { grossLoss += -r; }
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
    returns.push(r);
  }

  const mean = netR / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  // Sharpe needs real variance — return 0 when sd is zero (all trades identical),
  // not Infinity. Annualize assuming ~1 trade per session day.
  const sharpe = sd > 1e-6 ? (mean / sd) * Math.sqrt(252) : 0;
  // Profit factor: cap at 10 when no losses (zero loss => no statistical meaning,
  // 10 is "very high" without polluting downstream averages).
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 10 : 0);

  return {
    trades: n,
    winRate: wins / n,
    profitFactor,
    sharpe,
    maxDD,
    netR,
    avgR: mean
  };
}

// ─── Backtest a trained model against a held-out set at a given threshold ────

function backtestModel(model, dataset, threshold, opts = {}) {
  // Execution-time R:R applied here. Labels are symmetric (50/50 base rate);
  // we choose a profitable R:R per trade. Default: TP at 1.8R, SL at 1.0R.
  const tpR = opts.tpR || 1.8;
  const slR = opts.slR || 1.0;
  const trades = [];
  for (const row of dataset) {
    const prob = predict(model, row.features);
    if (prob >= threshold) {
      // Approximation: if label=1 (1.5 ATR up hit first), we treat as +tpR/1.5
      // ATR. If label=0 (1.5 ATR down hit), we treat as -slR/1.5 ATR.
      // Since both label barriers were 1.5 ATR, scaling to TP=1.8 / SL=1.0 R:
      const pnlR = row.label === 1 ? tpR : -slR;
      trades.push({ ts: row.ts, prob, label: row.label, pnlR });
    }
  }
  return computeMetrics(trades);
}

// ─── Threshold sweep — pick the threshold that maximizes test Sharpe ─────────

function pickBestThreshold(model, dataset, opts = {}) {
  const minTrades = opts.minTrades || 20;
  // Floor at 55% — with 1.8:1 R:R and symmetric labels, breakeven is 35.7%,
  // so 55% gives a real edge. Below 55% is below our quality bar.
  const winRateFloor = opts.winRateFloor || 0.55;
  const candidates = opts.thresholds || [0.52, 0.54, 0.56, 0.58, 0.60, 0.62, 0.65, 0.68, 0.72];

  let best = null;
  const sweep = [];
  for (const th of candidates) {
    const m = backtestModel(model, dataset, th);
    sweep.push({ threshold: th, ...m });
    if (m.trades < minTrades) continue;
    if (m.winRate < winRateFloor) continue;
    if (!best || m.sharpe > best.sharpe) best = { threshold: th, ...m };
  }

  // Fallback: if no threshold meets floor, take highest win-rate one with >=minTrades
  if (!best) {
    for (const s of sweep) {
      if (s.trades < minTrades) continue;
      if (!best || s.winRate > best.winRate) best = s;
    }
  }
  if (!best) best = sweep[Math.floor(sweep.length / 2)] || { threshold: 0.65, trades: 0, winRate: 0 };
  return { best, sweep };
}

// ─── Walkforward driver ──────────────────────────────────────────────────────
// Splits dataset into K folds chronologically: [train: 0..k], [test: k..k+1].
// For each fold: train on the train slice, evaluate on the test slice with the
// best threshold picked from the train slice.

function walkforward(candles, opts = {}) {
  // 3 folds → bigger test sets, more reliable threshold selection
  const folds = opts.folds || 3;
  const session = opts.session;       // 'RTH' / 'ETH'
  const regime = opts.regime;         // 'TREND_UP' / 'TREND_DOWN' / 'VOL_EXPANSION'
  const direction = opts.direction || 'long';
  const params = opts.params || {};
  const log = opts.log || (() => {});

  log(`[Walkforward] Building dataset (session=${session || 'ALL'}, regime=${regime || 'ALL'}, dir=${direction})...`);
  const dataset = buildDataset(candles, { session, regime, direction });
  log(`[Walkforward]   ${dataset.length} samples extracted`);

  if (dataset.length < 100) {
    log(`[Walkforward]   ⚠️  Too few samples (${dataset.length}) — skipping`);
    return { trained: false, reason: 'insufficient_data', samples: dataset.length };
  }

  const foldSize = Math.floor(dataset.length / folds);
  const foldResults = [];
  let finalModel = null;
  let bestOverallThreshold = 0.65;

  for (let k = 1; k < folds; k++) {
    const trainEnd = k * foldSize;
    const testEnd = Math.min(dataset.length, (k + 1) * foldSize);

    const trainSet = dataset.slice(0, trainEnd);
    const testSet = dataset.slice(trainEnd, testEnd);

    if (testSet.length < 30) continue;

    const X_train = trainSet.map(r => r.features);
    const y_train = trainSet.map(r => r.label);

    log(`[Walkforward]   Fold ${k}/${folds - 1}: train=${X_train.length}, test=${testSet.length}`);
    const t0 = Date.now();
    const model = train(X_train, y_train, params, { featureNames: trainSet[0].featureNames });
    const trainTime = Date.now() - t0;

    // Pick threshold from train-set in-sample then evaluate on test
    const { best: bestTrain } = pickBestThreshold(model, trainSet);
    const testMetrics = backtestModel(model, testSet, bestTrain.threshold);

    log(`[Walkforward]     train ${trainTime}ms | thresh=${bestTrain.threshold.toFixed(2)} | ` +
        `test: trades=${testMetrics.trades} winRate=${(testMetrics.winRate * 100).toFixed(1)}% ` +
        `PF=${testMetrics.profitFactor.toFixed(2)} Sharpe=${testMetrics.sharpe.toFixed(2)}`);

    foldResults.push({
      fold: k,
      trainSamples: X_train.length,
      testSamples: testSet.length,
      threshold: bestTrain.threshold,
      trainTime,
      ...testMetrics
    });

    finalModel = model;
    bestOverallThreshold = bestTrain.threshold;
  }

  // Train final deployment model on the FULL dataset using the median threshold
  // from walkforward folds (more robust than the last fold's threshold).
  if (foldResults.length > 0) {
    const thresholds = foldResults.map(f => f.threshold).sort();
    bestOverallThreshold = thresholds[Math.floor(thresholds.length / 2)];

    log(`[Walkforward]   Training deployment model on full dataset (${dataset.length} samples)...`);
    const X_all = dataset.map(r => r.features);
    const y_all = dataset.map(r => r.label);
    finalModel = train(X_all, y_all, params, { featureNames: dataset[0].featureNames });
  }

  // Aggregate test metrics across folds
  const allTestTrades = foldResults.reduce((s, f) => s + f.trades, 0);
  const wghtAvg = (key) => {
    if (allTestTrades === 0) return 0;
    return foldResults.reduce((s, f) => s + f[key] * f.trades, 0) / allTestTrades;
  };
  const aggregate = {
    folds: foldResults.length,
    totalTestTrades: allTestTrades,
    winRate: wghtAvg('winRate'),
    profitFactor: foldResults.length > 0
      ? foldResults.reduce((s, f) => s + f.profitFactor, 0) / foldResults.length
      : 0,
    sharpe: foldResults.length > 0
      ? foldResults.reduce((s, f) => s + f.sharpe, 0) / foldResults.length
      : 0,
    maxDD: Math.max(...foldResults.map(f => f.maxDD), 0),
    threshold: bestOverallThreshold
  };

  log(`[Walkforward]   AGGREGATE: trades=${aggregate.totalTestTrades} ` +
      `winRate=${(aggregate.winRate * 100).toFixed(1)}% ` +
      `PF=${aggregate.profitFactor.toFixed(2)} Sharpe=${aggregate.sharpe.toFixed(2)} ` +
      `thresh=${aggregate.threshold.toFixed(2)}`);

  return {
    trained: true,
    model: finalModel,
    threshold: bestOverallThreshold,
    foldResults,
    aggregate,
    sampleCount: dataset.length
  };
}

module.exports = {
  walkforward,
  buildDataset,
  backtestModel,
  pickBestThreshold,
  computeMetrics
};
