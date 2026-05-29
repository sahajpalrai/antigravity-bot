#!/usr/bin/env python3
"""
Antigravity Gate 2 — ML Filter Trainer
========================================
Trains a single dual-output LightGBM binary classifier used as a CONFIDENCE
FILTER (not a signal generator). Called after the pattern engine fires — blocks
patterns where the ML model disagrees.

Key differences from Gate 1 GBDT trainer:
  - Single model (not 48 specialists)
  - All regimes + sessions combined (regime is a feature, not a split)
  - Output: long_prob = P(price up > 2xATR within 12 bars)
             short_prob = 1 - long_prob
  - Threshold: RTH 0.55, ETH 0.53 (V6 T1 tier — only proven profitable tier)
  - No CHOP training (regime filtered before this runs)

Triple-barrier labeling (same as Gate 1):
  - Target:  +2x ATR within 12 bars = label 1 (long)
  - Stop:    -1x ATR within 12 bars = label 0 (short)
  - Timeout: 12 bars with no hit = label by direction of close

Usage:
  python gate2/scripts/train_ml_filter.py [--quick] [--days 90]
  Saves: gate2/models/ml_filter.pkl
         gate2/models/ml_filter_meta.json
"""

import argparse
import json
import os
import pickle
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

ROOT      = Path(__file__).resolve().parent.parent.parent
DATA_DIR  = ROOT / "data"
GATE2_DIR = ROOT / "gate2"
MODEL_OUT = GATE2_DIR / "models" / "ml_filter.pkl"
META_OUT  = GATE2_DIR / "models" / "ml_filter_meta.json"

FEATURE_NAMES = [
    "ema9_dist", "ema21_dist", "ema50_dist", "ema200_dist",
    "ema9_21_gap", "ema21_50_gap",
    "rsi", "macd_hist", "macd_line", "adx",
    "atr_pct", "atr_percentile", "bb_z", "bb_bandwidth",
    "vol_z", "ret_1", "ret_5", "ret_20",
    "body_ratio", "wick_asym",
    "hour_of_day", "session_rth",
    "is_equity_family", "is_cl_family", "is_gc_family",
    "day_of_week_norm", "eia_window", "london_session",
    "vwap_dev_atr", "intraday_mom", "gap_atr", "vol_trend"
]

SYMBOLS = ["NQ", "ES", "CL", "GC"]

def load_csv(symbol: str, days: int) -> pd.DataFrame | None:
    """Load OHLCV CSV for a symbol, keep last N days."""
    sym_lc = symbol.lower()
    candidates = [
        DATA_DIR / f"{sym_lc}_5m.csv",
        DATA_DIR / f"{sym_lc}.csv",
        # NT8 export naming convention used by the pre-seed pipeline
        DATA_DIR / f"{sym_lc}_5min_nt8.csv",
        DATA_DIR / f"m{sym_lc}_5min_nt8.csv",   # micro variant (mnq, mes …)
    ]
    for f in candidates:
        if f.exists():
            df = pd.read_csv(f)
            if len(df) > 100:
                # Normalize column names: lowercase + strip BOM so 'Close' → 'close'
                df.columns = [c.strip().lower().replace('﻿', '') for c in df.columns]
                # Gate 1 trainer expects time column named "time" — rename any alias
                for alias in ("datetime", "date", "timestamp"):
                    if alias in df.columns:
                        df = df.rename(columns={alias: "time"})
                        break
                # Keep last `days` days worth of 5-min bars (~78 bars/day)
                bars_per_day = 78
                cutoff = max(0, len(df) - days * bars_per_day)
                return df.iloc[cutoff:].reset_index(drop=True)
    return None

def _compute_features(df: pd.DataFrame, symbol: str) -> tuple[np.ndarray, np.ndarray]:
    """
    Compute feature matrix from OHLCV DataFrame.
    Mirrors featureEngineer.js — same 32 features.
    Returns (X, times) arrays.
    """
    # Reuse Gate 1 trainer's feature computation (same pipeline)
    gate1_trainer = ROOT / "scripts" / "train_lgbm.py"
    if not gate1_trainer.exists():
        raise FileNotFoundError(f"Gate 1 trainer not found at {gate1_trainer}")

    # Import Gate 1 trainer functions dynamically
    import importlib.util
    spec = importlib.util.spec_from_file_location("train_lgbm", gate1_trainer)
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    # Gate 1 trainer's build_features_matrix handles all 32 features
    return mod.build_features_matrix(df, symbol)

def _triple_barrier_labels(
        df: pd.DataFrame, X: np.ndarray, row_indices: np.ndarray,
        atr_col: np.ndarray, horizon: int = 12,
        tp_mult: float = 2.0, sl_mult: float = 1.0
) -> np.ndarray:
    """
    Triple-barrier labeling.
    label = 1 if +tp_mult * ATR hit before -sl_mult * ATR (within horizon bars)
    label = 0 otherwise (stop hit or timeout with price below entry)
    """
    closes = df['close'].values if 'close' in df.columns else df.iloc[:, 4].values
    n      = len(row_indices)
    labels = np.zeros(n, dtype=np.int8)

    for i, idx in enumerate(row_indices):
        entry  = closes[idx]
        atr    = atr_col[i]
        if atr <= 0:
            continue
        tp_price = entry + tp_mult * atr
        sl_price = entry - sl_mult * atr

        for j in range(1, horizon + 1):
            fut_idx = idx + j
            if fut_idx >= len(closes):
                break
            fut_close = closes[fut_idx]
            if fut_close >= tp_price:
                labels[i] = 1
                break
            if fut_close <= sl_price:
                labels[i] = 0
                break
        else:
            # Timeout — label by direction
            if idx + horizon < len(closes):
                labels[i] = 1 if closes[idx + horizon] > entry else 0

    return labels

def train(args):
    t0 = time.time()
    all_X, all_y = [], []

    for sym in SYMBOLS:
        print(f"\n[Gate2 Trainer] Loading {sym}...")
        df = load_csv(sym, args.days)
        if df is None or len(df) < 500:
            print(f"  SKIP — no data for {sym}")
            continue

        try:
            X, times = _compute_features(df, sym + "=F")
        except Exception as e:
            print(f"  SKIP — feature computation failed: {e}")
            continue

        n = len(X)
        row_indices = np.arange(n)

        # ATR from feature matrix (column index for atr_pct = 10)
        atr_pct_col = X[:, 10]
        closes      = df['close'].values[-n:] if len(df['close'].values) >= n else df['close'].values
        atr_abs     = atr_pct_col * closes[-n:]

        labels = _triple_barrier_labels(df.iloc[-n:].reset_index(drop=True),
                                        X, row_indices, atr_abs,
                                        horizon=12, tp_mult=2.0, sl_mult=1.0)

        all_X.append(X)
        all_y.append(labels)
        pos = labels.sum()
        print(f"  {sym}: {n} bars, {pos} long labels ({100*pos/n:.1f}%)")

    if not all_X:
        print("[Gate2 Trainer] ERROR: No data loaded. Cannot train.")
        sys.exit(1)

    X_all = np.vstack(all_X)
    y_all = np.concatenate(all_y)
    print(f"\n[Gate2 Trainer] Total samples: {len(X_all)} ({y_all.sum()} long = {100*y_all.mean():.1f}%)")

    # 4-fold chronological CV
    n        = len(X_all)
    n_folds  = 4
    fold_sz  = n // n_folds
    cv_aucs  = []

    params = dict(
        objective='binary', metric='auc', boosting_type='gbdt',
        num_leaves=31, max_depth=-1,
        learning_rate=0.05 if args.quick else 0.03,
        n_estimators=50 if args.quick else 150,
        min_child_samples=40, subsample=0.8, colsample_bytree=0.8,
        reg_alpha=0.1, reg_lambda=0.1, random_state=42, verbose=-1
    )

    print("[Gate2 Trainer] 4-fold CV...")
    for f in range(n_folds):
        ts, te = f * fold_sz, (f + 1) * fold_sz if f < n_folds - 1 else n
        X_tr = np.concatenate([X_all[:ts], X_all[te:]])
        y_tr = np.concatenate([y_all[:ts], y_all[te:]])
        X_te = X_all[ts:te]
        y_te = y_all[ts:te]

        model = lgb.LGBMClassifier(**params)
        model.fit(X_tr, y_tr)
        proba = model.predict_proba(X_te)[:, 1]

        from sklearn.metrics import roc_auc_score
        auc = roc_auc_score(y_te, proba)
        cv_aucs.append(auc)
        print(f"  Fold {f+1}: AUC = {auc:.4f}")

    cv_mean = float(np.mean(cv_aucs))
    cv_std  = float(np.std(cv_aucs))
    print(f"[Gate2 Trainer] CV AUC: {cv_mean:.4f} ± {cv_std:.4f}")

    # Train final model on all data
    print("[Gate2 Trainer] Training final model on all data...")
    final_model = lgb.LGBMClassifier(**params)
    final_model.fit(X_all, y_all)

    # Save
    with open(MODEL_OUT, 'wb') as f:
        pickle.dump(final_model, f)

    meta = {
        "trainedAt":    datetime.now(timezone.utc).isoformat(),
        "cv_auc_mean":  cv_mean,
        "cv_auc_std":   cv_std,
        "n_samples":    int(len(X_all)),
        "n_features":   len(FEATURE_NAMES),
        "feature_names": FEATURE_NAMES,
        "symbols":      SYMBOLS,
        "days":         args.days,
        "rth_threshold": 0.55,
        "eth_threshold": 0.53,
        "tp_mult":      2.0,
        "sl_mult":      1.0,
        "horizon_bars": 12,
        "_note": "single dual-output model; long_prob=P(up), short_prob=1-P(up). Used as filter, not primary signal."
    }
    META_OUT.write_text(json.dumps(meta, indent=2))

    elapsed = time.time() - t0
    print(f"\n[Gate2 Trainer] Done in {elapsed:.0f}s")
    print(f"  Model : {MODEL_OUT}")
    print(f"  CV AUC: {cv_mean:.4f}  (T1 threshold fires at 0.55 RTH / 0.53 ETH)")
    if cv_mean < 0.52:
        print("  WARNING: AUC < 0.52 — model is near-random. Review features before using as filter.")
    elif cv_mean >= 0.55:
        print("  GOOD: AUC >= 0.55 — meaningful edge, filter should help.")

def main():
    p = argparse.ArgumentParser(description="Gate 2 ML Filter Trainer")
    p.add_argument("--quick",  action="store_true")
    p.add_argument("--days",   type=int, default=90)
    args = p.parse_args()
    train(args)

if __name__ == '__main__':
    main()
