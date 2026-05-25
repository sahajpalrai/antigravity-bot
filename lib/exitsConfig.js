// Antigravity v2 — Exits override config
// Stores per-session (RTH/ETH) fixed exit values that override the default
// ATR-based dynamic exits when enabled. Used by decisionEngine when computing
// SL/TP/BE/Trail distances for a new entry.
//
// IMPORTANT: When fixed mode is on for a session, the walkforward backtest
// metrics no longer apply. The UI must warn the user clearly.

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'models', 'exit_overrides.json');

// Default config — all disabled, sensible point values per session
const DEFAULT_CONFIG = {
  RTH: {
    enabled: false,
    profitPoints: 9.0,      // ~1.8 ATR on NQ at 5pt ATR (illustrative defaults)
    stopPoints: 5.0,
    breakevenAtPoints: 4.0, // move SL to entry at this profit
    trailStartPoints: 6.0,  // start trailing at this profit
    trailStepPoints: 5.0    // trail stays this far behind price
  },
  ETH: {
    enabled: false,
    profitPoints: 6.0,
    stopPoints: 3.5,
    breakevenAtPoints: 3.0,
    trailStartPoints: 4.0,
    trailStepPoints: 3.0
  }
};

function _load() {
  if (!fs.existsSync(CONFIG_FILE)) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  try {
    const obj = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return {
      RTH: { ...DEFAULT_CONFIG.RTH, ...(obj.RTH || {}) },
      ETH: { ...DEFAULT_CONFIG.ETH, ...(obj.ETH || {}) }
    };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
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

function setExitsConfig(session, values) {
  if (session !== 'RTH' && session !== 'ETH') return false;
  const cfg = _load();
  // Whitelist editable fields — never trust raw input
  const allowed = ['enabled', 'profitPoints', 'stopPoints', 'breakevenAtPoints', 'trailStartPoints', 'trailStepPoints'];
  for (const k of allowed) {
    if (values[k] !== undefined) {
      if (k === 'enabled') {
        cfg[session][k] = !!values[k];
      } else {
        const n = parseFloat(values[k]);
        if (!isNaN(n) && n > 0) cfg[session][k] = n;
      }
    }
  }
  _save(cfg);
  return cfg;
}

// Returns the SL/TP/BE/Trail distances to use for a NEW entry, in price points.
// If fixed mode is enabled for the active session, returns those fixed values.
// Otherwise returns null — caller falls back to ATR-dynamic.
function fixedExitsFor(session) {
  const cfg = _load();
  const s = cfg[session];
  if (!s || !s.enabled) return null;
  return {
    slPoints: s.stopPoints,
    tpPoints: s.profitPoints,
    bePoints: s.breakevenAtPoints,
    trailStartPoints: s.trailStartPoints,
    trailStepPoints: s.trailStepPoints
  };
}

function isFixedActive() {
  const cfg = _load();
  return !!(cfg.RTH.enabled || cfg.ETH.enabled);
}

module.exports = {
  getExitsConfig,
  setExitsConfig,
  fixedExitsFor,
  isFixedActive,
  DEFAULT_CONFIG
};
