// Antigravity v2 — Gradient Boosted Decision Tree (binary classification)
// Pure-JS, zero deps, deterministic. Trains in seconds on tabular features.
// Output: P(label=1) — calibrated via the sigmoid of the boosted score.
//
// Algorithm: depth-limited regression trees fit on the negative gradient of
// log-loss (standard GBDT formulation). Each leaf stores a Newton step value.
// Serializes to plain JSON for live loading in the trading engine.

'use strict';

// ─── Sigmoid + log-loss derivatives ──────────────────────────────────────────

function sigmoid(x) {
  if (x > 40) return 1;
  if (x < -40) return 0;
  return 1 / (1 + Math.exp(-x));
}

// Negative gradient of log-loss at current prediction (in raw score space).
// For y∈{0,1} and p=sigmoid(F): grad = p - y  →  we fit -grad = y - p
function residual(y, p) { return y - p; }

// Newton step denominator: p*(1-p)
function hessian(p) { return p * (1 - p); }

// ─── Tree learner: best split via histogram on each feature ─────────────────

function bestSplit(X, residuals, hessians, indices, featureCount, minLeafSamples) {
  let bestGain = 0;
  let bestFeature = -1;
  let bestThreshold = 0;
  let bestLeftIdx = null;
  let bestRightIdx = null;

  if (indices.length < minLeafSamples * 2) return null;

  // Parent statistics
  let parentG = 0, parentH = 0;
  for (const i of indices) { parentG += residuals[i]; parentH += hessians[i]; }
  const parentScore = (parentG * parentG) / (parentH + 1e-6);

  for (let f = 0; f < featureCount; f++) {
    // Collect (value, idx) pairs, sort, scan thresholds
    const pairs = indices.map(i => [X[i][f], i]);
    pairs.sort((a, b) => a[0] - b[0]);

    let leftG = 0, leftH = 0;
    for (let k = 0; k < pairs.length - 1; k++) {
      const idx = pairs[k][1];
      leftG += residuals[idx];
      leftH += hessians[idx];

      // Skip duplicate threshold values
      if (pairs[k][0] === pairs[k + 1][0]) continue;
      if (k + 1 < minLeafSamples || pairs.length - k - 1 < minLeafSamples) continue;

      const rightG = parentG - leftG;
      const rightH = parentH - leftH;
      const gain = (leftG * leftG) / (leftH + 1e-6) +
                   (rightG * rightG) / (rightH + 1e-6) -
                   parentScore;

      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = f;
        bestThreshold = (pairs[k][0] + pairs[k + 1][0]) / 2;
        bestLeftIdx = pairs.slice(0, k + 1).map(p => p[1]);
        bestRightIdx = pairs.slice(k + 1).map(p => p[1]);
      }
    }
  }

  if (bestFeature === -1) return null;
  return {
    feature: bestFeature,
    threshold: bestThreshold,
    gain: bestGain,
    leftIdx: bestLeftIdx,
    rightIdx: bestRightIdx
  };
}

function leafValue(residuals, hessians, indices, lambda) {
  let g = 0, h = 0;
  for (const i of indices) { g += residuals[i]; h += hessians[i]; }
  return g / (h + lambda);
}

function buildTree(X, y, predictions, depth, maxDepth, minLeafSamples, lambda) {
  const n = X.length;
  const residuals = new Float64Array(n);
  const hessians = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = sigmoid(predictions[i]);
    residuals[i] = residual(y[i], p);
    hessians[i] = hessian(p);
  }

  const allIdx = [];
  for (let i = 0; i < n; i++) allIdx.push(i);

  function recurse(indices, currentDepth) {
    if (currentDepth >= maxDepth || indices.length < minLeafSamples * 2) {
      return { leaf: true, value: leafValue(residuals, hessians, indices, lambda) };
    }
    const split = bestSplit(X, residuals, hessians, indices, X[0].length, minLeafSamples);
    if (!split || split.gain < 0.001) {
      return { leaf: true, value: leafValue(residuals, hessians, indices, lambda) };
    }
    return {
      leaf: false,
      feature: split.feature,
      threshold: split.threshold,
      left: recurse(split.leftIdx, currentDepth + 1),
      right: recurse(split.rightIdx, currentDepth + 1)
    };
  }

  return recurse(allIdx, 0);
}

function predictTree(tree, x) {
  let node = tree;
  while (!node.leaf) {
    node = x[node.feature] <= node.threshold ? node.left : node.right;
  }
  return node.value;
}

// ─── GBDT trainer ─────────────────────────────────────────────────────────────

const DEFAULT_PARAMS = {
  nTrees: 100,
  maxDepth: 4,
  learningRate: 0.05,
  minLeafSamples: 20,
  lambda: 1.0,          // L2 regularization on leaf weights
  subsample: 1.0,        // row sampling per tree (1.0 = no sampling)
  baseScore: 0.0         // initial raw score (log-odds)
};

function train(X, y, params = {}, opts = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const n = X.length;
  if (n === 0) throw new Error('train: empty dataset');
  const featureCount = X[0].length;

  const predictions = new Float64Array(n).fill(p.baseScore);
  const trees = [];

  for (let t = 0; t < p.nTrees; t++) {
    // Optional subsample
    let X_t = X, y_t = y, preds_t = predictions, mapBack = null;
    if (p.subsample < 1.0) {
      const subN = Math.max(p.minLeafSamples * 4, Math.floor(n * p.subsample));
      const idx = new Set();
      while (idx.size < subN) idx.add(Math.floor(Math.random() * n));
      const idxArr = Array.from(idx);
      X_t = idxArr.map(i => X[i]);
      y_t = idxArr.map(i => y[i]);
      preds_t = new Float64Array(idxArr.length);
      for (let k = 0; k < idxArr.length; k++) preds_t[k] = predictions[idxArr[k]];
      mapBack = idxArr;
    }

    const tree = buildTree(X_t, y_t, preds_t, 0, p.maxDepth, p.minLeafSamples, p.lambda);
    trees.push(tree);

    // Update predictions on full set
    for (let i = 0; i < n; i++) {
      predictions[i] += p.learningRate * predictTree(tree, X[i]);
    }

    // Optional verbose callback
    if (opts.onIteration && (t === 0 || (t + 1) % 10 === 0 || t === p.nTrees - 1)) {
      let ll = 0;
      for (let i = 0; i < n; i++) {
        const pr = sigmoid(predictions[i]);
        ll += -(y[i] * Math.log(pr + 1e-9) + (1 - y[i]) * Math.log(1 - pr + 1e-9));
      }
      opts.onIteration(t + 1, ll / n);
    }
  }

  return {
    trees,
    params: p,
    featureCount,
    featureNames: opts.featureNames || null
  };
}

function predict(model, x) {
  let raw = model.params.baseScore;
  for (const tree of model.trees) {
    raw += model.params.learningRate * predictTree(tree, x);
  }
  return sigmoid(raw);
}

function predictBatch(model, X) {
  return X.map(x => predict(model, x));
}

// ─── Serialization ────────────────────────────────────────────────────────────

function serialize(model) {
  return JSON.stringify({
    version: 2,
    type: 'gbdt-binary',
    trained: new Date().toISOString(),
    featureNames: model.featureNames,
    featureCount: model.featureCount,
    params: model.params,
    trees: model.trees
  });
}

function deserialize(json) {
  const obj = typeof json === 'string' ? JSON.parse(json) : json;
  if (obj.type !== 'gbdt-binary') throw new Error('Unsupported model type: ' + obj.type);
  return {
    trees: obj.trees,
    params: obj.params,
    featureCount: obj.featureCount,
    featureNames: obj.featureNames
  };
}

// ─── Feature importance (split-count + gain weighted) ─────────────────────────

function featureImportance(model) {
  const counts = new Array(model.featureCount).fill(0);
  function walk(node) {
    if (node.leaf) return;
    counts[node.feature]++;
    walk(node.left);
    walk(node.right);
  }
  model.trees.forEach(walk);
  return counts;
}

module.exports = {
  train,
  predict,
  predictBatch,
  serialize,
  deserialize,
  featureImportance,
  sigmoid,
  DEFAULT_PARAMS
};
