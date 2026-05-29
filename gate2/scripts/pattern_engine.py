#!/usr/bin/env python3
"""
Antigravity Gate 2 — Pattern Engine
====================================
Flask service on port 3100. Receives bar + feature data from Node.js
and returns pattern-based trade signals.

7 patterns (from V4/V5 audit — only proven positive-EV or standard setups):
  1. FVG           — V5 2yr: 1,279 trades, 60.4% WR, +$0.167/trade (PROVEN)
  2. ORB           — Opening Range Breakout (V4 standard)
  3. EMA_RASCHKE   — 3-bar EMA9 pullback (V5: 5W/0L morning, small sample)
  4. RSI_REVERSAL  — RSI extreme + reversal bar (V5: 75% WR morning, 16 trades)
  5. DAILY_LEVEL   — Prev-day H/L break (V5: 6W/0L, small sample)
  6. VWAP_REVERSION — Price far from VWAP + reversal (V4 MR_VWAP)
  7. HTF_BREAK     — 15-min H/L break using 5-min bar aggregation (V4/V5)

Usage:
  python gate2/scripts/pattern_engine.py
  → listens on http://localhost:3100

POST /analyze
  body: {
    symbol: "NQ=F",
    session: "RTH",
    regime: "TREND_UP",
    candles: [...],   # last 50 OHLCV bars {open,high,low,close,volume,time}
    features: {...}   # 32 feature values by name
  }
  returns: {
    signal: "BUY"|"SELL"|"FLAT",
    pattern: "FVG"|"ORB"|...|null,
    agreeing_count: 0..7,
    ml_long_prob: 0.5,   # pass-through until model trained
    ml_short_prob: 0.5,
    fvg_live_trades: N,
    patterns: {FVG: "BUY"|"SELL"|"FLAT", ORB: ..., ...}
  }
"""

import json
import math
import os
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent  # D:\Google AntiGravity
GATE2_DIR = ROOT / "gate2"
CONFIG_FILE = GATE2_DIR / "config.json"
ML_MODEL_FILE = GATE2_DIR / "models" / "ml_filter.pkl"
ML_META_FILE  = GATE2_DIR / "models" / "ml_filter_meta.json"

# ── Config ────────────────────────────────────────────────────────────────────
def load_config():
    try:
        return json.loads(CONFIG_FILE.read_text())
    except Exception:
        return {
            "rthThreshold": 0.55, "ethThreshold": 0.53,
            "fvgLiveTrades": 0, "fvgLiveWins": 0,
            "fvgBypassMlAfterTrades": 100
        }

# ── ML Filter (pass-through until model is trained) ───────────────────────────
_ml_model = None
_ml_meta  = None
_ml_lock  = threading.Lock()

def _load_ml_model():
    global _ml_model, _ml_meta
    with _ml_lock:
        if not ML_MODEL_FILE.exists():
            return False
        try:
            import pickle
            with open(ML_MODEL_FILE, 'rb') as f:
                _ml_model = pickle.load(f)
            if ML_META_FILE.exists():
                _ml_meta = json.loads(ML_META_FILE.read_text())
            print(f"[PatternEngine] ML filter model loaded from {ML_MODEL_FILE}")
            return True
        except Exception as e:
            print(f"[PatternEngine] ML model load failed: {e}")
            return False

def _ml_predict(features_dict):
    """
    Returns (long_prob, short_prob).
    Falls back to (0.5, 0.5) if no model trained yet.
    """
    global _ml_model, _ml_meta
    if _ml_model is None:
        _load_ml_model()
    if _ml_model is None:
        return 0.5, 0.5
    try:
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
        x = [[features_dict.get(n, 0.0) for n in FEATURE_NAMES]]
        import numpy as np
        x_arr = np.array(x, dtype=np.float32)
        proba = _ml_model.predict_proba(x_arr)[0]
        long_prob = float(proba[1])   # P(up)
        short_prob = 1.0 - long_prob  # P(down)
        return long_prob, short_prob
    except Exception as e:
        print(f"[PatternEngine] ML predict error: {e}")
        return 0.5, 0.5

# ── Time helpers ──────────────────────────────────────────────────────────────
def _et_minutes(ts_ms):
    """Convert JS timestamp (ms) to ET minute-of-day (0-1439)."""
    d = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    month = d.month
    # Approximate DST: March through October = EDT (UTC-4); else EST (UTC-5)
    offset_h = 4 if 3 <= month <= 10 else 5
    et_hour = (d.hour - offset_h) % 24
    return et_hour * 60 + d.minute

def _et_date(ts_ms):
    """Return ET date string YYYY-MM-DD."""
    d = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    month = d.month
    offset_h = 4 if 3 <= month <= 10 else 5
    et = datetime(d.year, d.month, d.day, d.hour, d.minute,
                  tzinfo=timezone.utc)
    from datetime import timedelta
    et_local = d - timedelta(hours=offset_h)
    return et_local.strftime('%Y-%m-%d')

# ── Pattern 1: FVG (Fair Value Gap) ──────────────────────────────────────────
def detect_fvg(candles):
    """
    Bullish FVG: candle[i].low > candle[i-2].high  (gap up)
    Bearish FVG: candle[i].high < candle[i-2].low  (gap down)
    Signal: current price entering/filling the gap zone.
    Looks back 20 bars for recent unfilled gaps.
    """
    n = len(candles)
    if n < 4:
        return 'FLAT', None

    current_close = candles[-1]['close']
    lookback = min(20, n - 2)

    bullish_gaps = []  # list of (gap_low, gap_high)
    bearish_gaps = []

    for i in range(max(2, n - lookback - 1), n - 1):
        c0 = candles[i - 2]  # bar N-2
        c2 = candles[i]      # bar N (gap bar)
        # Bullish: gap up — space between c0.high and c2.low
        if c2['low'] > c0['high']:
            bullish_gaps.append((c0['high'], c2['low']))
        # Bearish: gap down — space between c2.high and c0.low
        if c2['high'] < c0['low']:
            bearish_gaps.append((c2['high'], c0['low']))

    # Most recent gaps have priority
    for gap_low, gap_high in reversed(bullish_gaps):
        if gap_low <= current_close <= gap_high:
            return 'BUY', f'FVG fill bullish {gap_low:.1f}-{gap_high:.1f}'

    for gap_low, gap_high in reversed(bearish_gaps):
        if gap_low <= current_close <= gap_high:
            return 'SELL', f'FVG fill bearish {gap_low:.1f}-{gap_high:.1f}'

    return 'FLAT', None

# ── Pattern 2: ORB (Opening Range Breakout) ───────────────────────────────────
def detect_orb(candles, session):
    """
    RTH only. Opening range = first 30 min (9:30-10:00 ET).
    Valid window for signals: 9:30-11:00 ET.
    """
    if session != 'RTH':
        return 'FLAT', None
    if not candles:
        return 'FLAT', None

    # Current bar time in ET minutes
    current_ts = candles[-1].get('time', 0)
    if not current_ts:
        return 'FLAT', None
    current_et = _et_minutes(current_ts)

    # Signal window: 9:30 AM (570) - 11:00 AM (660)
    if not (570 <= current_et <= 660):
        return 'FLAT', None

    # Build ORB range from 9:30-10:00 AM bars
    orb_high, orb_low = None, None
    for c in candles[:-1]:  # exclude current bar
        ts = c.get('time', 0)
        if not ts:
            continue
        et_min = _et_minutes(ts)
        if 570 <= et_min < 600:  # 9:30 to 9:59
            if orb_high is None:
                orb_high = c['high']
                orb_low  = c['low']
            else:
                orb_high = max(orb_high, c['high'])
                orb_low  = min(orb_low,  c['low'])

    if orb_high is None or orb_low is None:
        return 'FLAT', None

    # Minimum range filter — avoid tiny ORB on gap-and-drift opens
    if (orb_high - orb_low) < 5:  # 5 NQ points minimum
        return 'FLAT', None

    close = candles[-1]['close']
    if close > orb_high:
        return 'BUY', f'ORB break above {orb_high:.1f}'
    if close < orb_low:
        return 'SELL', f'ORB break below {orb_low:.1f}'

    return 'FLAT', None

# ── Pattern 3: EMA_RASCHKE ────────────────────────────────────────────────────
def detect_ema_raschke(candles, features):
    """
    3-bar EMA9 pullback continuation (Linda Bradford Raschke pattern).
    Uptrend: EMA9 above EMA21 → look for 2-bar pullback to EMA9 → green reversal.
    Downtrend: EMA9 below EMA21 → look for 2-bar rally to EMA9 → red reversal.
    """
    if len(candles) < 4:
        return 'FLAT', None

    ema9_21_gap = features.get('ema9_21_gap', 0)  # (ema9-ema21)/close
    ema9_dist   = features.get('ema9_dist', 0)     # (close-ema9)/close

    c  = candles[-1]   # current bar
    p1 = candles[-2]   # 1 bar ago
    p2 = candles[-3]   # 2 bars ago

    # Need solid trend: EMA9/EMA21 gap > 0.05% of price
    TREND_MIN = 0.0005

    if ema9_21_gap > TREND_MIN:
        # Uptrend — look for pullback (2 red bars) then green reversal near EMA9
        pullback = (p1['close'] < p1['open']) and (p2['close'] < p2['open'])
        reversal = c['close'] > c['open']
        near_ema9 = abs(ema9_dist) < 0.0020  # within 0.2% of EMA9
        if pullback and reversal and near_ema9:
            return 'BUY', 'Raschke pullback to EMA9 — reversal bar uptrend'

    if ema9_21_gap < -TREND_MIN:
        # Downtrend — look for rally (2 green bars) then red reversal near EMA9
        pullback = (p1['close'] > p1['open']) and (p2['close'] > p2['open'])
        reversal = c['close'] < c['open']
        near_ema9 = abs(ema9_dist) < 0.0020
        if pullback and reversal and near_ema9:
            return 'SELL', 'Raschke rally to EMA9 — reversal bar downtrend'

    return 'FLAT', None

# ── Pattern 4: RSI_REVERSAL ───────────────────────────────────────────────────
def detect_rsi_reversal(candles, features):
    """
    RSI extreme (< 30 or > 70) with a reversal candle.
    V5 evidence: 75% WR morning window (16 trades — small sample, monitor).
    """
    if len(candles) < 2:
        return 'FLAT', None

    rsi = features.get('rsi', 50.0)
    c   = candles[-1]
    body = c['close'] - c['open']

    # Oversold + green reversal bar
    if rsi < 30 and body > 0:
        return 'BUY', f'RSI oversold {rsi:.1f} + reversal bar'

    # Overbought + red reversal bar
    if rsi > 70 and body < 0:
        return 'SELL', f'RSI overbought {rsi:.1f} + reversal bar'

    return 'FLAT', None

# ── Pattern 5: DAILY_LEVEL ────────────────────────────────────────────────────
def detect_daily_level(candles, features):
    """
    Previous day high/low breakout.
    V5 evidence: 6W/0L (small sample — monitor closely).
    Only fires within 0.5 ATR of the level to avoid chasing distant breaks.
    """
    if len(candles) < 20:
        return 'FLAT', None

    # Compute ATR proxy from features
    atr_pct = features.get('atr_pct', 0.001)
    close   = candles[-1]['close']
    atr     = atr_pct * close  # rough ATR in price points

    # Find prev-day H/L from bar timestamps
    current_ts   = candles[-1].get('time', 0)
    current_date = _et_date(current_ts) if current_ts else None
    if not current_date:
        return 'FLAT', None

    prev_high, prev_low = None, None
    for c in candles[:-1]:
        ts = c.get('time', 0)
        if not ts:
            continue
        c_date = _et_date(ts)
        if c_date < current_date:
            if prev_high is None:
                prev_high = c['high']
                prev_low  = c['low']
            else:
                prev_high = max(prev_high, c['high'])
                prev_low  = min(prev_low,  c['low'])

    if prev_high is None:
        return 'FLAT', None

    # Signal: break of level, within 0.5 ATR of level (not already far)
    margin = atr * 0.5
    if prev_high <= close <= prev_high + margin:
        return 'BUY', f'PDH break {prev_high:.1f} (+{close - prev_high:.1f} pts)'
    if prev_low - margin <= close <= prev_low:
        return 'SELL', f'PDL break {prev_low:.1f} (-{prev_low - close:.1f} pts)'

    return 'FLAT', None

# ── Pattern 6: VWAP_REVERSION ─────────────────────────────────────────────────
def detect_vwap_reversion(candles, features, session):
    """
    Price more than 1.5 ATR from VWAP with a reversal candle.
    RTH only — VWAP drift in ETH is unreliable without institutional volume.
    V4 MR_VWAP — standard V4 module.
    """
    if session != 'RTH':
        return 'FLAT', None
    if len(candles) < 2:
        return 'FLAT', None

    vwap_dev = features.get('vwap_dev_atr', 0)  # deviation in ATR units
    c        = candles[-1]
    body     = c['close'] - c['open']

    # Too far above VWAP + red bar = fade / SHORT
    if vwap_dev > 1.5 and body < 0:
        return 'SELL', f'VWAP dev +{vwap_dev:.2f} ATR — fade reversal'

    # Too far below VWAP + green bar = mean reversion / LONG
    if vwap_dev < -1.5 and body > 0:
        return 'BUY', f'VWAP dev {vwap_dev:.2f} ATR — revert reversal'

    return 'FLAT', None

# ── Pattern 7: HTF_BREAK ─────────────────────────────────────────────────────
def detect_htf_break(candles):
    """
    15-minute high/low breakout using 5-min bar aggregation.
    15-min range = last 3 completed 5-min bars before the current bar.
    V4/V5 standard module.
    """
    if len(candles) < 5:
        return 'FLAT', None

    # Last 3 completed bars (exclude current) = 15-min range
    htf_bars = candles[-4:-1]
    htf_high = max(b['high'] for b in htf_bars)
    htf_low  = min(b['low']  for b in htf_bars)

    # Minimum range guard — avoid break signals on tight consolidation
    if (htf_high - htf_low) < 3:  # 3 NQ points
        return 'FLAT', None

    close = candles[-1]['close']

    # Clean close beyond the range (not just a wick)
    if close > htf_high:
        return 'BUY', f'HTF break above {htf_high:.1f}'
    if close < htf_low:
        return 'SELL', f'HTF break below {htf_low:.1f}'

    return 'FLAT', None

# ── Aggregator ────────────────────────────────────────────────────────────────
def run_all_patterns(candles, features, session, regime):
    """
    Run all 7 patterns. Returns:
      signal        : 'BUY' | 'SELL' | 'FLAT'
      pattern       : name of strongest/first pattern that fired
      agreeing_count: how many patterns agree on the signal direction
      patterns      : dict of {pattern_name: signal}
      details       : dict of {pattern_name: detail_string}
    """
    results = {}
    details = {}

    def run(name, fn, *args):
        try:
            sig, detail = fn(*args)
            results[name] = sig
            details[name] = detail or ''
        except Exception as e:
            results[name] = 'FLAT'
            details[name] = f'error: {e}'

    run('FVG',           detect_fvg,           candles)
    run('ORB',           detect_orb,           candles, session)
    run('EMA_RASCHKE',   detect_ema_raschke,   candles, features)
    run('RSI_REVERSAL',  detect_rsi_reversal,  candles, features)
    run('DAILY_LEVEL',   detect_daily_level,   candles, features)
    run('VWAP_REVERSION',detect_vwap_reversion,candles, features, session)
    run('HTF_BREAK',     detect_htf_break,     candles)

    # Count votes
    buy_votes  = [(n, d) for n, (s, d) in zip(results.keys(), details.items()) if results[n] == 'BUY']
    sell_votes = [(n, d) for n, (s, d) in zip(results.keys(), details.items()) if results[n] == 'SELL']
    buy_count  = sum(1 for n in results if results[n] == 'BUY')
    sell_count = sum(1 for n in results if results[n] == 'SELL')

    # FVG gets priority if it fires (highest-confidence pattern)
    fvg_sig = results.get('FVG', 'FLAT')
    if fvg_sig != 'FLAT':
        signal  = fvg_sig
        pattern = 'FVG'
        agreeing = buy_count if fvg_sig == 'BUY' else sell_count
    elif buy_count > sell_count and buy_count >= 1:
        signal   = 'BUY'
        pattern  = next((n for n in results if results[n] == 'BUY'), None)
        agreeing = buy_count
    elif sell_count > buy_count and sell_count >= 1:
        signal   = 'SELL'
        pattern  = next((n for n in results if results[n] == 'SELL'), None)
        agreeing = sell_count
    else:
        signal   = 'FLAT'
        pattern  = None
        agreeing = 0

    return signal, pattern, agreeing, results, details

# ── HTTP Handler ──────────────────────────────────────────────────────────────
class PatternHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # suppress default access log

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body   = self.rfile.read(length)
            req    = json.loads(body)
        except Exception as e:
            self._send(400, {'error': f'bad request: {e}'})
            return

        if self.path == '/analyze':
            self._handle_analyze(req)
        elif self.path == '/health':
            self._send(200, {'status': 'ok'})
        else:
            self._send(404, {'error': 'not found'})

    def do_GET(self):
        if self.path == '/health':
            self._send(200, {'status': 'ok', 'patterns': 7, 'ml_loaded': _ml_model is not None})
        else:
            self._send(404, {'error': 'not found'})

    def _handle_analyze(self, req):
        try:
            symbol   = req.get('symbol', 'NQ=F')
            session  = req.get('session', 'RTH')
            regime   = req.get('regime', 'CHOP')
            candles  = req.get('candles', [])
            features = req.get('features', {})

            if len(candles) < 4:
                self._send(200, {
                    'signal': 'FLAT', 'pattern': None, 'agreeing_count': 0,
                    'ml_long_prob': 0.5, 'ml_short_prob': 0.5,
                    'patterns': {}, 'reason': 'insufficient_candles'
                })
                return

            # Run patterns
            signal, pattern, agreeing, pat_results, pat_details = \
                run_all_patterns(candles, features, session, regime)

            # ML filter (pass-through until model trained)
            ml_long, ml_short = _ml_predict(features)

            # Load config for FVG bypass threshold
            cfg = load_config()
            fvg_live = cfg.get('fvgLiveTrades', 0)

            self._send(200, {
                'signal':          signal,
                'pattern':         pattern,
                'agreeing_count':  agreeing,
                'ml_long_prob':    round(ml_long, 4),
                'ml_short_prob':   round(ml_short, 4),
                'ml_trained':      _ml_model is not None,
                'fvg_live_trades': fvg_live,
                'patterns':        pat_results,
                'details':         pat_details
            })

        except Exception as e:
            import traceback
            traceback.print_exc()
            self._send(500, {'error': str(e)})

    def _send(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    port = int(os.environ.get('PATTERN_ENGINE_PORT', 3100))
    print(f'[PatternEngine] Starting on http://localhost:{port}')
    print(f'[PatternEngine] Patterns: FVG | ORB | EMA_RASCHKE | RSI_REVERSAL | DAILY_LEVEL | VWAP_REVERSION | HTF_BREAK')
    print(f'[PatternEngine] ML model: {"LOADED" if ML_MODEL_FILE.exists() else "NOT YET TRAINED — using pass-through 0.5/0.5"}')

    server = HTTPServer(('localhost', port), PatternHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('[PatternEngine] Stopped.')
