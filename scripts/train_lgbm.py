#!/usr/bin/env python3
"""
Antigravity v2 — Track A: LightGBM Trainer
============================================
Replaces the JS custom GBDT with LightGBM.

Usage:
    python scripts/train_lgbm.py [--symbols NQ,ES,CL,GC] [--auto-rollback] [--quick]

Key design:
  - Same feature pipeline as lib/featureEngineer.js (32 features, identical computation)
  - Same walkforward structure (4-fold chronological CV + median threshold)
  - Same triple-barrier labeling (1.5x ATR, max 12 bars)
  - Same JSON output format (compatible with lib/gbdtModel.js reader)
  - LightGBM with leaf-wise tree growth: ~90s for 64 bundles vs 8+ min for JS GBDT
  - Outputs models/ as NQ_RTH_TREND_UP_long.json etc.

Output JSON per bundle (same schema as JS GBDT trainer):
{
  "type": "lgbm",
  "version": 2,
  "symbol": "NQ=F",
  "session": "RTH",
  "regime": "TREND_UP",
  "direction": "long",
  "featureNames": [...],
  "threshold": 0.68,
  "aggregate": { "winRate": 0.63, "profitFactor": 1.82, "totalTestTrades": 220, "sharpeRatio": 7.2 },
  "model": { ... lgbm model dump ... }
}
"""

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT      = Path(__file__).resolve().parent.parent
DATA_DIR  = ROOT / "data"
MODEL_DIR = ROOT / "models"
LOG_DIR   = MODEL_DIR / "retrain_logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

# ── Feature names (must match JS featureEngineer.js EXACTLY — positions 0–31) ─
FEATURE_NAMES = [
    # Core 22 (positions 0–21)
    "ema9_dist", "ema21_dist", "ema50_dist", "ema200_dist",
    "ema9_21_gap", "ema21_50_gap",
    "rsi", "macd_hist", "macd_line", "adx",
    "atr_pct", "atr_percentile", "bb_z", "bb_bandwidth",
    "vol_z",
    "ret_1", "ret_5", "ret_20",
    "body_ratio", "wick_asym",
    "hour_of_day", "session_rth",
    # Instrument-specific (positions 22–27)
    "is_equity_family", "is_cl_family", "is_gc_family",
    "day_of_week_norm", "eia_window", "london_session",
    # Track C (positions 28–31)
    "vwap_dev_atr", "intraday_mom", "gap_atr", "vol_trend"
]

# ── Regime + session constants ─────────────────────────────────────────────────
REGIMES    = ["TREND_UP", "TREND_DOWN", "CHOP", "VOL_EXPANSION"]
SESSIONS   = ["RTH", "ETH"]
DIRECTIONS = ["long", "short"]
THRESHOLDS = [0.52, 0.54, 0.56, 0.58, 0.60, 0.62, 0.65, 0.68, 0.72, 0.75, 0.78, 0.82]

# ── LightGBM params ───────────────────────────────────────────────────────────
# Leaf-wise boosting (LightGBM default). num_leaves controls model complexity.
# min_child_samples prevents leaves with too few samples (regularization).
def get_lgbm_params(quick=False):
    return dict(
        objective        = "binary",
        metric           = "auc",
        boosting_type    = "gbdt",
        num_leaves       = 31,
        max_depth        = -1,
        learning_rate    = 0.05 if quick else 0.03,
        n_estimators     = 50  if quick else 150,
        min_child_samples = 40,
        subsample        = 0.8,
        colsample_bytree = 0.8,
        reg_alpha        = 0.1,
        reg_lambda        = 0.1,
        random_state     = 42,
        verbose          = -1,
    )


# ── CSV loader ────────────────────────────────────────────────────────────────
MICRO_TO_MINI = {"MNQ": "nq", "MES": "es", "MCL": "cl", "MGC": "gc"}

def load_csv(symbol: str) -> pd.DataFrame | None:
    base = symbol.replace("=F", "").upper()
    mini = MICRO_TO_MINI.get(base, base.lower())
    fname = DATA_DIR / f"{mini}_5min_nt8.csv"
    if not fname.exists():
        print(f"  [Error] Missing CSV: {fname}")
        return None
    df = pd.read_csv(fname, low_memory=False)
    # Normalise column names (lower, strip spaces)
    df.columns = [c.strip().lower() for c in df.columns]
    # Must have: datetime/time, open, high, low, close, volume
    time_col = next((c for c in df.columns if c in ("datetime", "time", "date", "timestamp")), None)
    if time_col is None:
        print(f"  [Error] No time column in {fname}: {list(df.columns)[:6]}")
        return None
    df = df.rename(columns={time_col: "time"})
    for col in ("open", "high", "low", "close"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["volume"] = pd.to_numeric(df.get("volume", pd.Series(1000, index=df.index)), errors="coerce").fillna(1000)
    df = df.dropna(subset=["time", "open", "high", "low", "close"])
    df = df.sort_values("time").reset_index(drop=True)
    return df


# ── Feature computation (mirrors featureEngineer.js exactly) ──────────────────

def _ema_series(closes: np.ndarray, period: int) -> np.ndarray:
    out = np.full(len(closes), np.nan)
    if len(closes) < period:
        return out
    k = 2.0 / (period + 1)
    e = closes[:period].mean()
    out[period - 1] = e
    for i in range(period, len(closes)):
        e = closes[i] * k + e * (1 - k)
        out[i] = e
    return out

def _rsi(closes: np.ndarray, period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    diff = np.diff(closes[-(period+1):])
    gain = diff[diff > 0].sum() / period
    loss = -diff[diff < 0].sum() / period
    if loss == 0:
        return 100.0
    return 100 - 100 / (1 + gain / loss)

def _macd(closes: np.ndarray, fast=12, slow=26, signal=9):
    if len(closes) < slow + signal:
        return None
    f_ser = _ema_series(closes, fast)
    s_ser = _ema_series(closes, slow)
    ml    = f_ser - s_ser
    valid = np.where(~np.isnan(ml))[0]
    if len(valid) == 0:
        return None
    clean = ml[valid[0]:]
    sig_ser = _ema_series(clean, signal)
    last_sig  = sig_ser[-1]
    last_macd = ml[-1]
    if np.isnan(last_sig) or np.isnan(last_macd):
        return None
    return {"macd": last_macd, "signal": last_sig, "hist": last_macd - last_sig}

def _atr(df_slice: pd.DataFrame, period: int = 14) -> float | None:
    if len(df_slice) < period + 1:
        return None
    h = df_slice["high"].values
    l = df_slice["low"].values
    c = df_slice["close"].values
    trs = []
    for i in range(len(h) - period, len(h)):
        tr = max(h[i] - l[i], abs(h[i] - c[i-1]), abs(l[i] - c[i-1]))
        trs.append(tr)
    return sum(trs) / period

def _bollinger(closes: np.ndarray, period=20):
    if len(closes) < period:
        return None
    sl = closes[-period:]
    mid = sl.mean()
    sd  = sl.std(ddof=0)
    if sd == 0:
        return None
    return {"mid": mid, "sd": sd, "bandwidth": (4 * sd) / mid, "z": (closes[-1] - mid) / sd}

def _adx(df_slice: pd.DataFrame, period=14) -> float:
    if len(df_slice) < period * 2 + 1:
        return 20.0
    h = df_slice["high"].values
    l = df_slice["low"].values
    c = df_slice["close"].values
    trs, plus_dm, minus_dm = [], [], []
    for i in range(1, len(h)):
        up   = h[i] - h[i-1]
        down = l[i-1] - l[i]
        plus_dm.append(up   if up > down and up > 0   else 0.0)
        minus_dm.append(down if down > up and down > 0 else 0.0)
        trs.append(max(h[i]-l[i], abs(h[i]-c[i-1]), abs(l[i]-c[i-1])))
    atr_s = sum(trs[:period])
    pdm_s = sum(plus_dm[:period])
    mdm_s = sum(minus_dm[:period])
    dxs = []
    for i in range(period, len(trs)):
        atr_s = atr_s - atr_s / period + trs[i]
        pdm_s = pdm_s - pdm_s / period + plus_dm[i]
        mdm_s = mdm_s - mdm_s / period + minus_dm[i]
        pdi   = 100 * pdm_s / atr_s if atr_s else 0
        mdi   = 100 * mdm_s / atr_s if atr_s else 0
        denom = pdi + mdi or 1
        dxs.append(100 * abs(pdi - mdi) / denom)
    if len(dxs) < period:
        return 20.0
    return sum(dxs[-period:]) / period

def _session(ts_str: str, symbol: str) -> str:
    """RTH/ETH decision from timestamp string (PT time embedded in string)."""
    # Timestamps are in PT: "2023-05-23 09:30:00-07:00"
    try:
        hm = ts_str[11:16]
        h, m = int(hm[:2]), int(hm[3:5])
    except Exception:
        return "ETH"
    mins = h * 60 + m
    fam  = symbol.replace("=F", "").upper()
    fam  = fam[1:] if (fam.startswith("M") and len(fam) == 3) else fam
    from datetime import date
    try:
        day = datetime.strptime(ts_str[:10], "%Y-%m-%d").weekday()  # 0=Mon
        weekday = 0 <= day <= 4
    except Exception:
        weekday = True
    if not weekday:
        return "ETH"
    if fam == "CL"  and 360 <= mins < 690:   return "RTH"
    if fam == "GC"  and 320 <= mins < 630:   return "RTH"
    if mins >= 390  and mins < 780:           return "RTH"  # NQ/ES
    return "ETH"

def _regime(row_features: dict) -> str:
    """Classify regime from feature dict (mirrors regimeClassifier.js)."""
    adx_v   = row_features.get("adx", 20)
    bb_bw   = row_features.get("bb_bandwidth", 0)
    ema_gap = row_features.get("ema9_21_gap", 0)  # sign gives trend direction
    ema50g  = row_features.get("ema21_50_gap", 0)

    if adx_v >= 30 and bb_bw > 0.03:
        return "VOL_EXPANSION"
    if adx_v >= 22:
        return "TREND_UP" if ema_gap > 0 else "TREND_DOWN"
    return "CHOP"

def _rolling_vwap(df_slice: pd.DataFrame, lookback=80) -> float:
    s = df_slice.tail(lookback)
    tp    = (s["high"] + s["low"] + s["close"]) / 3
    vol   = s["volume"].clip(lower=1)
    denom = vol.sum()
    return (tp * vol).sum() / denom if denom > 0 else 0.0

def _date_of(ts_str: str) -> str:
    return ts_str[:10]

def _first_bar_of_day_close(df_slice: pd.DataFrame) -> float:
    today = _date_of(df_slice.iloc[-1]["time"])
    for i in range(len(df_slice) - 2, -1, -1):
        if _date_of(df_slice.iloc[i]["time"]) != today:
            return df_slice.iloc[i + 1]["close"]
    return df_slice.iloc[max(0, len(df_slice) - 78)]["close"]

def _gap_atr(df_slice: pd.DataFrame, atr_val: float) -> float:
    if atr_val <= 0:
        return 0.0
    today = _date_of(df_slice.iloc[-1]["time"])
    first_today = len(df_slice) - 1
    last_yest   = -1
    for i in range(len(df_slice) - 2, -1, -1):
        if _date_of(df_slice.iloc[i]["time"]) == today:
            first_today = i
        else:
            last_yest = i
            break
    if last_yest < 0:
        return 0.0
    return (df_slice.iloc[first_today]["open"] - df_slice.iloc[last_yest]["close"]) / atr_val


MIN_BARS = 220

def build_features_matrix(df: pd.DataFrame, symbol: str):
    """
    Vectorized feature builder. Computes every indicator ONCE across the full
    DataFrame (O(n) total), then assembles the feature matrix in a single pass.
    Returns (X: np.ndarray[n_valid, 32], valid_idx: np.ndarray[n_valid]).

    Replaces the old build_features_row which recomputed EMAs from scratch for
    every bar (O(n²) — catastrophically slow on 200K+ row datasets).
    """
    n = len(df)
    c = df["close"].values.astype(np.float64)
    h = df["high"].values.astype(np.float64)
    l = df["low"].values.astype(np.float64)
    o = df["open"].values.astype(np.float64)
    v = df["volume"].values.astype(np.float64)

    # ── EMAs — each called ONCE, O(n) ──────────────────────────────────────────
    ema9   = _ema_series(c,   9)
    ema12  = _ema_series(c,  12)
    ema21  = _ema_series(c,  21)
    ema26  = _ema_series(c,  26)
    ema50  = _ema_series(c,  50)
    ema200 = _ema_series(c, 200)

    # ── ATR (Wilder smoothing) ──────────────────────────────────────────────────
    prev_c = np.empty_like(c); prev_c[0] = c[0]; prev_c[1:] = c[:-1]
    tr     = np.maximum(h - l, np.maximum(np.abs(h - prev_c), np.abs(l - prev_c)))
    atr    = np.full(n, np.nan)
    if n > 14:
        atr[13] = tr[1:15].mean()
        for i in range(14, n):
            atr[i] = (atr[i-1] * 13 + tr[i]) / 14

    # ATR percentile (rolling 100-bar)
    atr_pctile = np.full(n, 0.5)
    for i in range(114, n):
        w = tr[i-99:i+1]
        atr_pctile[i] = float(np.mean(w <= atr[i]))

    # ── RSI (Wilder smoothing) ──────────────────────────────────────────────────
    diff   = np.diff(c, prepend=c[0])
    gains  = np.where(diff > 0, diff, 0.0)
    losses = np.where(diff < 0, -diff, 0.0)
    rsi_arr = np.full(n, np.nan)
    if n > 15:
        ag = gains[1:15].mean(); al = losses[1:15].mean()
        for i in range(14, n):
            if i > 14:
                ag = (ag * 13 + gains[i]) / 14
                al = (al * 13 + losses[i]) / 14
            rsi_arr[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)

    # ── MACD ────────────────────────────────────────────────────────────────────
    macd_line = ema12 - ema26
    fv_list   = np.where(~np.isnan(macd_line))[0]
    macd_sig  = np.full(n, np.nan)
    macd_hist = np.full(n, np.nan)
    if len(fv_list) > 0:
        fv = fv_list[0]
        sig = _ema_series(macd_line[fv:], 9)
        macd_sig[fv:]  = sig
        macd_hist[fv:] = macd_line[fv:] - sig

    # ── Bollinger Bands (rolling 20) ────────────────────────────────────────────
    bb_z  = np.full(n, np.nan)
    bb_bw = np.full(n, np.nan)
    for i in range(19, n):
        sl = c[i-19:i+1]; mid = sl.mean(); sd = sl.std(ddof=0)
        if sd > 0:
            bb_z[i]  = (c[i] - mid) / sd
            bb_bw[i] = (4 * sd) / mid

    # ── ADX (Wilder smoothing) ──────────────────────────────────────────────────
    up  = h[1:] - h[:-1]; dn = l[:-1] - l[1:]
    pdm = np.where((up > dn) & (up > 0), up, 0.0)
    mdm = np.where((dn > up) & (dn > 0), dn, 0.0)
    adx_arr = np.full(n, 20.0)
    if n > 30:
        atr14 = tr[1:15].mean(); pdm14 = pdm[:14].mean(); mdm14 = mdm[:14].mean()
        dx_vals = []
        for i in range(14, n-1):
            atr14 = (atr14*13 + tr[i+1]) / 14
            pdm14 = (pdm14*13 + pdm[i])  / 14
            mdm14 = (mdm14*13 + mdm[i])  / 14
            pdi   = 100*pdm14/atr14 if atr14 > 0 else 0
            mdi   = 100*mdm14/atr14 if atr14 > 0 else 0
            dx_vals.append(100 * abs(pdi - mdi) / ((pdi+mdi) or 1))
        if len(dx_vals) >= 14:
            adx14 = sum(dx_vals[:14]) / 14
            for j, dxv in enumerate(dx_vals[14:]):
                adx14 = (adx14*13 + dxv) / 14
                adx_arr[j + 29] = adx14

    # ── Vol z-score (rolling 50) ────────────────────────────────────────────────
    vol_z = np.zeros(n)
    for i in range(50, n):
        rv = v[i-49:i+1]; vm = rv.mean(); vs = rv.std(ddof=0)
        vol_z[i] = (v[i] - vm) / (vs or 1.0)

    # ── Candle shape ────────────────────────────────────────────────────────────
    rng_arr  = np.maximum(h - l, 1e-9)
    body_arr = np.abs(c - o) / rng_arr
    uw_arr   = (h - np.maximum(o, c)) / rng_arr
    lw_arr   = (np.minimum(o, c) - l) / rng_arr
    wick_asy = uw_arr - lw_arr

    # ── Returns ─────────────────────────────────────────────────────────────────
    ret1  = np.zeros(n); ret5  = np.zeros(n); ret20 = np.zeros(n)
    ret1[1:]   = np.where(c[:-1]  != 0, (c[1:]  - c[:-1])  / c[:-1],  0)
    ret5[5:]   = np.where(c[:-5]  != 0, (c[5:]  - c[:-5])  / c[:-5],  0)
    ret20[20:] = np.where(c[:-20] != 0, (c[20:] - c[:-20]) / c[:-20], 0)

    # ── Time / instrument features ───────────────────────────────────────────────
    fam  = symbol.replace("=F","").upper()
    fam  = fam[1:] if (fam.startswith("M") and len(fam)==3) else fam
    is_eq = 1.0 if fam in ("NQ","ES") else 0.0
    is_cl = 1.0 if fam == "CL" else 0.0
    is_gc = 1.0 if fam == "GC" else 0.0

    times    = df["time"].astype(str).values
    hours    = np.zeros(n, dtype=np.float32)
    sess_rth = np.zeros(n, dtype=np.float32)
    dow_norm = np.zeros(n, dtype=np.float32)
    eia_win  = np.zeros(n, dtype=np.float32)
    london_f = np.zeros(n, dtype=np.float32)
    dates    = np.array([ts[:10] for ts in times])

    for i in range(n):
        ts = times[i]
        try:
            hi = int(ts[11:13]); mi = int(ts[14:16])
            hours[i] = float(hi); pt = hi*60 + mi
            day = datetime.strptime(ts[:10], "%Y-%m-%d").weekday()
            if 0 <= day <= 4:
                if is_cl and 360 <= pt < 690:      sess_rth[i] = 1.0
                elif is_gc and 320 <= pt < 630:    sess_rth[i] = 1.0
                elif 390 <= pt < 780:               sess_rth[i] = 1.0
            dow_norm[i] = day/4.0 if 0 <= day <= 4 else 0.0
            if is_cl and day == 2 and 360 <= pt < 540:          eia_win[i]  = 1.0
            if (is_cl or is_gc) and (pt < 300 or pt >= 1380):   london_f[i] = 1.0
        except Exception:
            pass

    # ── Track C: gap_atr + intraday_mom (group by day, O(n)) ────────────────────
    gap_atr_arr   = np.zeros(n)
    intra_mom_arr = np.zeros(n)
    day_idx: dict = {}
    for i, d in enumerate(dates):
        day_idx.setdefault(d, []).append(i)
    sorted_dates = sorted(day_idx.keys())
    for di, d in enumerate(sorted_dates):
        idxs   = day_idx[d]
        first_c = c[idxs[0]]
        for idx in idxs:
            if not np.isnan(atr[idx]) and atr[idx] > 0:
                intra_mom_arr[idx] = (c[idx] - first_c) / atr[idx]
        if di > 0:
            prev_idxs  = day_idx[sorted_dates[di-1]]
            prev_close = c[prev_idxs[-1]]
            a0 = atr[idxs[0]]
            g  = (o[idxs[0]] - prev_close) / a0 if (not np.isnan(a0) and a0 > 0) else 0.0
            for idx in idxs:
                gap_atr_arr[idx] = g

    # ── Rolling VWAP (80-bar) ────────────────────────────────────────────────────
    vwap_arr = np.zeros(n)
    for i in range(80, n):
        sv = np.clip(v[i-79:i+1], 1, None)
        tp = (h[i-79:i+1] + l[i-79:i+1] + c[i-79:i+1]) / 3
        vwap_arr[i] = (tp * sv).sum() / sv.sum()

    # ── Vol trend (5-bar avg / 20-bar avg) ──────────────────────────────────────
    vol_trend = np.ones(n)
    for i in range(20, n):
        v5  = v[max(0,i-4):i+1].mean()
        v20 = v[i-19:i+1].mean()
        vol_trend[i] = v5 / (v20 or 1.0)

    # ── Final pass: collect valid rows (O(n) indexing only) ─────────────────────
    valid_idx: list = []
    rows:      list = []
    for i in range(MIN_BARS, n - 12):
        if (np.isnan(ema200[i]) or np.isnan(rsi_arr[i]) or
                np.isnan(macd_hist[i]) or np.isnan(bb_z[i]) or
                np.isnan(atr[i]) or atr[i] <= 0):
            continue
        rows.append([
            (c[i]-ema9[i])/c[i],    (c[i]-ema21[i])/c[i],
            (c[i]-ema50[i])/c[i],   (c[i]-ema200[i])/c[i],
            (ema9[i]-ema21[i])/c[i], (ema21[i]-ema50[i])/c[i],
            rsi_arr[i], macd_hist[i], ema12[i]-ema26[i], adx_arr[i],
            atr[i]/c[i], atr_pctile[i], bb_z[i], bb_bw[i],
            vol_z[i], ret1[i], ret5[i], ret20[i],
            body_arr[i], wick_asy[i],
            hours[i], sess_rth[i],
            is_eq, is_cl, is_gc,
            dow_norm[i], eia_win[i], london_f[i],
            (c[i]-vwap_arr[i])/atr[i] if vwap_arr[i] > 0 else 0.0,
            intra_mom_arr[i], gap_atr_arr[i], vol_trend[i],
        ])
        valid_idx.append(i)

    if not rows:
        return np.empty((0, 32), dtype=np.float32), np.array([], dtype=np.int64)
    return np.array(rows, dtype=np.float32), np.array(valid_idx, dtype=np.int64)


# ── Label builder (mirrors walkforward.js triple-barrier labeling) ────────────

def build_labels(df: pd.DataFrame, features_matrix, indices, direction: str,
                 atr_mult: float = 1.5, max_bars: int = 12) -> np.ndarray:
    """
    Triple-barrier labels for each row index.
    direction='long'  → label=1 when upper barrier hit first
    direction='short' → label=1 when lower barrier hit first
    """
    closes = df["close"].values
    n      = len(indices)
    labels = np.zeros(n, dtype=np.int8)

    for pos, idx in enumerate(indices):
        if idx + 1 >= len(df):
            continue
        # Recompute ATR for this bar (approximate — use average of last 14 TRs)
        atr_slice = df.iloc[max(0, idx-14):idx+1]
        atr_v = _atr(atr_slice, min(14, len(atr_slice)-1))
        if atr_v is None or atr_v <= 0:
            continue
        entry   = closes[idx]
        upper   = entry + atr_v * atr_mult
        lower   = entry - atr_v * atr_mult
        outcome = 0
        for k in range(1, max_bars + 1):
            if idx + k >= len(closes):
                break
            p = closes[idx + k]
            if p >= upper:
                outcome = 1  # upper barrier hit
                break
            if p <= lower:
                outcome = -1  # lower barrier hit
                break
        if direction == "long":
            labels[pos] = 1 if outcome == 1 else 0
        else:
            labels[pos] = 1 if outcome == -1 else 0

    return labels


# ── Walkforward trainer ────────────────────────────────────────────────────────

def pick_best_threshold(y_true: np.ndarray, y_prob: np.ndarray) -> tuple[float, dict]:
    """Sweep threshold candidates, return (best_threshold, metrics_dict)."""
    best_th, best_score = 0.65, 0.0
    best_metrics = {}
    for th in THRESHOLDS:
        mask = y_prob >= th
        if mask.sum() < 20:
            continue
        wins   = y_true[mask].sum()
        trades = mask.sum()
        wr     = wins / trades
        # Profit factor (assuming 1:1 R — same as JS trainer)
        pf = wins / max(1, trades - wins)
        sharpe = (wr - 0.5) / max(0.001, np.std(y_true[mask].astype(float) - wr)) * np.sqrt(trades)
        score  = wr * pf  # maximize WR * PF
        if score > best_score and wr >= 0.50:
            best_score   = score
            best_th      = th
            best_metrics = {"winRate": float(wr), "profitFactor": float(pf),
                            "totalTestTrades": int(trades), "sharpeRatio": float(sharpe)}
    return best_th, best_metrics


def train_bundle(df: pd.DataFrame, symbol: str, session: str, regime: str,
                 direction: str,
                 X_all: np.ndarray, all_idx: np.ndarray,
                 sess_arr: np.ndarray, reg_arr: np.ndarray,
                 opts: dict) -> dict | None:
    """
    Train one bundle from a precomputed feature matrix.
    X_all/all_idx/sess_arr/reg_arr are computed once per symbol by the caller.
    """
    t0 = time.time()

    mask = (sess_arr == session) & (reg_arr == regime)
    X    = X_all[mask]
    row_indices = all_idx[mask]

    if len(X) < 200:
        print(f"  SKIP: only {len(X)} matching samples")
        return None

    y  = build_labels(df, X, row_indices, direction)
    n  = len(X)
    n_folds = 4
    fold_size = n // n_folds
    if fold_size < 50:
        return None

    # 4-fold chronological cross-validation
    fold_thresholds, fold_metrics_list = [], []
    for f in range(n_folds):
        test_start = f * fold_size
        test_end   = (f + 1) * fold_size if f < n_folds - 1 else n
        X_train = np.concatenate([X[:test_start], X[test_end:]], axis=0)
        y_train = np.concatenate([y[:test_start], y[test_end:]], axis=0)
        X_test  = X[test_start:test_end]
        y_test  = y[test_start:test_end]

        if len(X_train) < 100 or len(X_test) < 20:
            continue

        params = get_lgbm_params(opts.get("quick", False))
        model  = lgb.LGBMClassifier(**params)
        model.fit(X_train, y_train)
        y_prob = model.predict_proba(X_test)[:, 1]

        th, metrics = pick_best_threshold(y_test, y_prob)
        if metrics:
            fold_thresholds.append(th)
            fold_metrics_list.append(metrics)

    if not fold_thresholds:
        return None

    # Median threshold across folds
    final_threshold = float(np.median(fold_thresholds))

    # Average aggregate metrics (simple mean across folds)
    agg = {
        "winRate":          float(np.mean([m["winRate"]          for m in fold_metrics_list])),
        "profitFactor":     float(np.mean([m["profitFactor"]     for m in fold_metrics_list])),
        "totalTestTrades":  int(np.mean([m["totalTestTrades"]   for m in fold_metrics_list])),
        "sharpeRatio":      float(np.mean([m["sharpeRatio"]      for m in fold_metrics_list])),
    }

    # Quality gate — Phase 1 fix 2026-05-28: unified floors, PF 1.30, Sharpe gate
    wr_floor     = opts.get("rthFloor",    0.60) if session == "RTH" else opts.get("ethFloor",    0.58)
    pf_floor     = opts.get("pfFloor",     1.30)
    sharpe_floor = opts.get("sharpeFloor", 0.80)
    fails = []
    if agg["winRate"]      < wr_floor:     fails.append(f"WR={agg['winRate']:.1%}<{wr_floor:.0%}")
    if agg["profitFactor"] < pf_floor:     fails.append(f"PF={agg['profitFactor']:.2f}<{pf_floor:.2f}")
    if agg["sharpeRatio"]  < sharpe_floor: fails.append(f"Sharpe={agg['sharpeRatio']:.2f}<{sharpe_floor:.2f}")
    if agg["totalTestTrades"] < 40:        fails.append(f"trades={agg['totalTestTrades']}<40")
    if fails:
        print(f"  QUALITY FAIL: {', '.join(fails)}")
        return None

    # Train FINAL model on all data
    final_params = get_lgbm_params(opts.get("quick", False))
    final_model  = lgb.LGBMClassifier(**final_params)
    final_model.fit(X, y)

    elapsed = time.time() - t0
    print(f"  DEPLOYED -> WR={agg['winRate']:.1%} PF={agg['profitFactor']:.2f} "
          f"Sharpe={agg['sharpeRatio']:.1f} th={final_threshold:.2f} "
          f"trades={agg['totalTestTrades']} ({elapsed:.0f}s)")

    return {
        "type":         "lgbm",
        "version":      2,
        "symbol":       symbol,
        "session":      session,
        "regime":       regime,
        "direction":    direction,
        "featureNames": FEATURE_NAMES,
        "threshold":    final_threshold,
        "aggregate":    agg,
        "trainedAt":    datetime.now(timezone.utc).isoformat(),
        "model":        final_model.booster_.dump_model(),
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Antigravity v2 LightGBM trainer")
    parser.add_argument("--symbols",      default="NQ,ES,CL,GC")
    parser.add_argument("--auto-rollback", action="store_true")
    parser.add_argument("--quick",         action="store_true")
    parser.add_argument("--rth-floor",    type=float, default=0.60)
    parser.add_argument("--eth-floor",    type=float, default=0.58)
    parser.add_argument("--pf-floor",     type=float, default=1.30)
    parser.add_argument("--sharpe-floor", type=float, default=0.80)
    parser.add_argument("--skip-chop",    action="store_true", default=True,
                        help="Skip CHOP bundle training (0W/9L live — permanently blocked)")
    parser.add_argument("--no-skip-chop", dest="skip_chop", action="store_false",
                        help="Force-train CHOP bundles (dangerous — use only for research)")
    args = parser.parse_args()

    symbols = [s.strip() + ("=F" if "=F" not in s else "") for s in args.symbols.split(",")]
    opts    = {
        "quick":       args.quick,
        "rthFloor":    args.rth_floor,
        "ethFloor":    args.eth_floor,
        "pfFloor":     args.pf_floor,
        "sharpeFloor": args.sharpe_floor,
        "skipChop":    args.skip_chop,
    }

    ts_str = datetime.now().strftime("%Y%m%d_%H%M")
    logfile = LOG_DIR / f"lgbm_{ts_str}.log"

    # Redirect stdout to both console and log
    import io
    class Tee(io.TextIOWrapper):
        def __init__(self, stream, f):
            self._s = stream; self._f = f
        def write(self, msg):
            self._s.write(msg); self._f.write(msg); self._f.flush()
        def flush(self):
            self._s.flush(); self._f.flush()

    logf   = open(logfile, "w", encoding="utf-8")
    orig   = sys.stdout
    # Force UTF-8 on Windows where default stdout may be cp1252
    if hasattr(sys.stdout, 'reconfigure'):
        try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        except Exception: pass
    sys.stdout = Tee(orig, logf)  # type: ignore

    print("=" * 60)
    print("  ANTIGRAVITY v2 — LightGBM TRAINER (Track A)")
    print("=" * 60)
    print(f"Symbols:    {', '.join(symbols)}")
    print(f"Mode:       {'quick (50 trees)' if args.quick else 'full (150 trees)'}")
    print(f"WR floors:  RTH={args.rth_floor:.0%}  ETH={args.eth_floor:.0%}")
    print(f"Auto-rollback: {'ON' if args.auto_rollback else 'OFF'}")
    print(f"Started:    {datetime.now().isoformat()}")
    print()

    t_total = time.time()
    deployed = 0; rejected = 0; rolled_back = 0

    for symbol in symbols:
        print(f"\n{'='*60}")
        print(f"Loading {symbol}...")
        df = load_csv(symbol)
        if df is None:
            print(f"  Skipped (no CSV)")
            continue
        print(f"  {len(df):,} candles loaded")

        # ── Precompute feature matrix once for this symbol ────────────────────
        print(f"  Building feature matrix (vectorized)…")
        t_feat = time.time()
        X_all, all_idx = build_features_matrix(df, symbol)
        print(f"  {len(X_all):,} valid feature rows  ({time.time()-t_feat:.1f}s)")
        if len(X_all) == 0:
            print("  No valid rows — skipping symbol")
            continue

        # Precompute session + regime label per row (O(n), done once)
        times_sub = df["time"].astype(str).values
        sess_arr  = np.array([_session(times_sub[i], symbol) for i in all_idx])
        reg_arr   = np.array([
            _regime(dict(zip(FEATURE_NAMES, X_all[j].tolist())))
            for j in range(len(all_idx))
        ])

        for session in SESSIONS:
            for regime in REGIMES:
                # Skip CHOP by default — 0W/9L live record across all systems.
                # CHOP permanently blocked in isTradeable(). Training it wastes
                # compute and may accidentally lower overall WR averages.
                # Re-enable only with --no-skip-chop flag + explicit research intent.
                if opts.get("skipChop", True) and regime == "CHOP":
                    print(f"  [SKIP] {session}_{regime} — CHOP permanently blocked (use --no-skip-chop to force)")
                    continue
                for direction in DIRECTIONS:
                    out_path = MODEL_DIR / f"{symbol.replace('=F','')}_{session}_{regime}_{direction}.json"
                    print(f"\n[{symbol} {session}_{regime}_{direction}] Training…")
                    try:
                        result = train_bundle(df, symbol, session, regime, direction,
                                              X_all, all_idx, sess_arr, reg_arr, opts)
                    except Exception as e:
                        print(f"  ERROR: {e}")
                        traceback.print_exc()
                        result = None

                    if result is None:
                        rejected += 1
                        continue

                    # Auto-rollback: compare Sharpe to existing
                    if args.auto_rollback and out_path.exists():
                        try:
                            existing = json.loads(out_path.read_text())
                            old_sharpe = existing.get("aggregate", {}).get("sharpeRatio", 0)
                            new_sharpe = result["aggregate"]["sharpeRatio"]
                            if new_sharpe < old_sharpe * 0.85:
                                print(f"  ROLLBACK: new Sharpe {new_sharpe:.1f} < 85% of old {old_sharpe:.1f}")
                                rolled_back += 1
                                continue
                        except Exception:
                            pass  # write new model anyway

                    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
                    deployed += 1

    elapsed = time.time() - t_total
    print(f"\n{'='*60}")
    print(f"SUMMARY: deployed={deployed}  rejected={rejected}  rolled_back={rolled_back}")
    print(f"Total runtime: {elapsed:.0f}s ({elapsed/60:.1f} min)")
    print(f"Log: {logfile}")
    print("Trainer complete.")

    sys.stdout = orig
    logf.close()


if __name__ == "__main__":
    main()
    # main() returning normally IS success. On Windows/Py3.14 the lightgbm/OpenMP
    # teardown after main() can make the interpreter exit non-zero with NO traceback,
    # which the retrain wrapper read as FAIL and false-alarmed the watchdog (deployed=4
    # but "FAIL rc=1"). Flush, then hard-exit 0 to bypass the noisy teardown. A real
    # failure raises INSIDE main() -> traceback -> non-zero exit before this line, so
    # genuine crashes are still reported.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
