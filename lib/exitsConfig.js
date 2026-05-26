// Antigravity v2 — Exits override config (PER-SYMBOL)
// Stores per-symbol × per-session (RTH/ETH) fixed exit values that override
// the default ATR-based dynamic exits when enabled. Used by decisionEngine
// when computing SL/TP/BE/Trail distances for a new entry.
//
// Schema (exit_overrides.json):
// {
//   "NQ=F": {
//     "RTH": { enabled, profitPoints, stopPoints, breakevenAtPoints, trailStartPoints, trailStepPoints },
//     "ETH": { ... }
//   },
//   "ES=F": { ... }, ...
//   "MGC=F": { ... }
// }
//
// IMPORTANT: When fixed mode is on for a symbol's session, the walkforward
// backtest metrics no longer apply to that symbol. The UI warns the user.

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'models', 'exit_overrides.json');

// All 8 symbols: 4 mini + 4 micro
const ALL_SYMBOLS = ['NQ=F', 'ES=F', 'CL=F', 'GC=F', 'MNQ=F', 'MES=F', 'MCL=F', 'MGC=F'];

// Sensible default point values calibrated per symbol's typical intraday range.
// Points are identical for mini vs micro of the same family — only $ value
// per point differs.
// NQ:  1pt = $20 mini / $2 micro    — moves 20-50 pts intraday
// ES:  1pt = $50 mini / $5 micro    — moves 5-15 pts intraday
// CL:  1pt = $1000 mini / $100 micro — moves 0.5-2 pts intraday
// GC:  1pt = $100 mini / $10 micro  — moves 3-15 pts intraday
const SYMBOL_DEFAULTS = {
  'NQ=F': { RTH: { profitPoints: 12,  stopPoints: 6,   breakevenAtPoints: 4,   trailStartPoints: 6,   trailStepPoints: 5    },
            ETH: { profitPoints: 6,   stopPoints: 3.5, breakevenAtPoints: 3,   trailStartPoints: 4,   trailStepPoints: 3    } },
  'ES=F': { RTH: { profitPoints: 6,   stopPoints: 3,   breakevenAtPoints: 2,   trailStartPoints: 3,   trailStepPoints: 2    },
            ETH: { profitPoints: 3,   stopPoints: 1.5, breakevenAtPoints: 1.5, trailStartPoints: 2,   trailStepPoints: 1.5  } },
  'CL=F': { RTH: { profitPoints: 0.8, stopPoints: 0.4, breakevenAtPoints: 0.3, trailStartPoints: 0.4, trailStepPoints: 0.3  },
            ETH: { profitPoints: 0.4, stopPoints: 0.25,breakevenAtPoints: 0.2, trailStartPoints: 0.25,trailStepPoints: 0.2  } },
  'GC=F': { RTH: { profitPoints: 12,  stopPoints: 6,   breakevenAtPoints: 5,   trailStartPoints: 6,   trailStepPoints: 5    },
            ETH: { profitPoints: 6,   stopPoints: 3,   breakevenAtPoints: 2.5, trailStartPoints: 3,   trailStepPoints: 2.5  } }
};

// Micros inherit from their mini family — same price scale
function _defaultsFor(symbol) {
  const family = symbol.startsWith('M') && symbol !== 'MGC=F' && symbol !== 'MGC' ? symbol.replace(/^M/, '') : symbol;
  // Strip micro prefix safely: MNQ=F → NQ=F, MES=F → ES=F, etc.
  const miniSym = symbol.startsWith('M') ? symbol.substring(1) : symbol;
  const base = SYMBOL_DEFAULTS[miniSym] || SYMBOL_DEFAULTS['NQ=F'];
  return {
    RTH: { enabled: false, ...base.RTH },
    ETH: { enabled: false, ...base.ETH }
  };
}

function _defaultConfig() {
  const cfg = {};
  for (const sym of ALL_SYMBOLS) cfg[sym] = _defaultsFor(sym);
  return cfg;
}

function _load() {
  if (!fs.existsSync(CONFIG_FILE)) return _defaultConfig();
  try {
    const obj = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    // LEGACY MIGRATION: old schema was a flat { RTH: {...}, ETH: {...} }
    // (one config shared across all symbols). Detect and migrate to per-symbol.
    if (obj && obj.RTH && obj.ETH && !obj['NQ=F']) {
      const cfg = _defaultConfig();
      for (const sym of ALL_SYMBOLS) {
        cfg[sym].RTH = { ...cfg[sym].RTH, ...obj.RTH };
        cfg[sym].ETH = { ...cfg[sym].ETH, ...obj.ETH };
      }
      _save(cfg);
      return cfg;
    }
    // Current schema — merge with defaults to fill any missing symbols/fields
    const cfg = _defaultConfig();
    for (const sym of ALL_SYMBOLS) {
      if (obj[sym]) {
        cfg[sym].RTH = { ...cfg[sym].RTH, ...(obj[sym].RTH || {}) };
        cfg[sym].ETH = { ...cfg[sym].ETH, ...(obj[sym].ETH || {}) };
      }
    }
    return cfg;
  } catch (e) {
    return _defaultConfig();
  }
}

function _save(cfg) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

function getExitsConfig() {
  return _load();
}

// Update a SINGLE symbol's session config. Whitelisted fields only.
function setExitsConfig(symbol, session, values) {
  if (!ALL_SYMBOLS.includes(symbol)) return false;
  if (session !== 'RTH' && session !== 'ETH') return false;
  const cfg = _load();
  const allowed = ['enabled', 'profitPoints', 'stopPoints', 'breakevenAtPoints', 'trailStartPoints', 'trailStepPoints'];
  for (const k of allowed) {
    if (values[k] !== undefined) {
      if (k === 'enabled') {
        cfg[symbol][session][k] = !!values[k];
      } else {
        const n = parseFloat(values[k]);
        if (!isNaN(n) && n > 0) cfg[symbol][session][k] = n;
      }
    }
  }
  _save(cfg);
  return cfg;
}

// Returns the SL/TP/BE/Trail distances to use for a NEW entry, in price points.
// If fixed mode is enabled for THIS symbol+session, returns those fixed values.
// Otherwise returns null — caller falls back to ATR-dynamic.
function fixedExitsFor(symbol, session) {
  const cfg = _load();
  const symCfg = cfg[symbol];
  if (!symCfg) return null;
  const s = symCfg[session];
  if (!s || !s.enabled) return null;
  return {
    slPoints: s.stopPoints,
    tpPoints: s.profitPoints,
    bePoints: s.breakevenAtPoints,
    trailStartPoints: s.trailStartPoints,
    trailStepPoints: s.trailStepPoints
  };
}

// Returns true if ANY symbol has at least one session in fixed mode — drives
// the dashboard's "fixed exits active, walkforward stats don't apply" warning.
function isFixedActive() {
  const cfg = _load();
  for (const sym of ALL_SYMBOLS) {
    if (cfg[sym] && (cfg[sym].RTH.enabled || cfg[sym].ETH.enabled)) return true;
  }
  return false;
}

module.exports = {
  getExitsConfig,
  setExitsConfig,
  fixedExitsFor,
  isFixedActive,
  ALL_SYMBOLS,
  SYMBOL_DEFAULTS
};
