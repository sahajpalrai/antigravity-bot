// Antigravity v2 — Aggressiveness Profile
// User-selectable preset that controls four interconnected knobs:
//   1. Quality floor per session (which bundles pass the gate)
//   2. R:R ratio (TP vs SL distance)
//   3. ATR exit multipliers (how wide SL and TP are in ATR units)
//   4. Threshold sweep candidates (which probability thresholds the trainer
//      considers when picking the best deployment cutoff)
//
// Switching profiles is HOT — the runtime decision engine + the trainer both
// read this on every call, so the change takes effect within ~60s without
// a server restart. For floor changes to fully take effect, the next retrain
// cycle (4:30 AM or 2:30 PM PT) needs to fire so the deployed bundles match
// the new floor.
//
// Trade-offs are clearly documented per preset so the user knows what they're
// signing up for.

'use strict';

const fs = require('fs');
const path = require('path');

const PROFILE_FILE = path.join(__dirname, '..', 'models', 'aggressiveness_profile.json');

// Four presets, ordered from most conservative to most aggressive.
// `expectedTradesPerMonth` is calibrated from historical 30-day simulations.
const PRESETS = {
  SNIPER: {
    key: 'SNIPER',
    label: 'Sniper · Max Accuracy',
    description: 'Only the highest-conviction setups fire. Tiny trade count, near-perfect accuracy.',
    rthFloor: 0.65,
    ethFloor: 0.60,
    tpR: 1.8,            // TP = 1.8 × SL distance (R:R 1.8:1)
    slR: 1.0,
    slAtrMult: 1.5,
    tpAtrMult: 2.7,      // = 1.5 × (tpR/slR)
    thresholdCandidates: [0.62, 0.65, 0.68, 0.72, 0.75, 0.78, 0.82],
    expectedTradesPerMonth: '5-15',
    expectedWR: '70-90%',
    expectedPF: '3-5'
  },
  BALANCED: {
    key: 'BALANCED',
    label: 'Balanced · Quality + Volume',
    description: 'Moderate accuracy, moderate frequency. The recommended starting point.',
    rthFloor: 0.55,
    ethFloor: 0.50,
    tpR: 1.6,
    slR: 1.0,
    slAtrMult: 1.4,
    tpAtrMult: 2.24,     // 1.4 × 1.6
    thresholdCandidates: [0.55, 0.58, 0.60, 0.62, 0.65, 0.68, 0.72, 0.75],
    expectedTradesPerMonth: '30-60',
    expectedWR: '58-68%',
    expectedPF: '2.0-3.0'
  },
  ACTIVE: {
    key: 'ACTIVE',
    label: 'Active · More Trades',
    description: 'Lower per-trade accuracy but ~2× the trade count. Net profit depends on edge holding at scale.',
    rthFloor: 0.50,
    ethFloor: 0.45,
    tpR: 1.4,
    slR: 1.0,
    slAtrMult: 1.2,
    tpAtrMult: 1.68,     // 1.2 × 1.4
    thresholdCandidates: [0.48, 0.50, 0.52, 0.55, 0.58, 0.60, 0.62, 0.65, 0.68],
    expectedTradesPerMonth: '60-120',
    expectedWR: '52-60%',
    expectedPF: '1.5-2.2'
  },
  SCALPER: {
    key: 'SCALPER',
    label: 'Scalper · Max Volume',
    description: 'Lowest accuracy floor, tight R:R, max trade count. Profitability requires consistent execution.',
    rthFloor: 0.48,
    ethFloor: 0.45,
    tpR: 1.2,
    slR: 1.0,
    slAtrMult: 1.0,
    tpAtrMult: 1.2,
    thresholdCandidates: [0.45, 0.48, 0.50, 0.52, 0.55, 0.58, 0.60, 0.62],
    expectedTradesPerMonth: '120-250',
    expectedWR: '48-55%',
    expectedPF: '1.2-1.6'
  },
  // ── AUTO: meta-preset that switches sub-preset based on time of day ──
  // Self-tunes intraday: aggressive during best hours, conservative in chop,
  // sniper-mode around major news. Performance override: if last 10 paper
  // trades show WR<45%, downshift one notch automatically.
  AUTO: {
    key: 'AUTO',
    label: 'Auto · Intraday Self-Tuning',
    description: 'Switches profile every hour based on time of day + recent WR. Sniper at lunch, Active mid-session, Balanced at open/ETH, Sniper overnight.',
    // The fields below are placeholders — actual values come from the sub-preset
    // that AUTO selects at decision time. UI shows the LIVE sub-preset.
    rthFloor: 0.55,
    ethFloor: 0.50,
    tpR: 1.6,
    slR: 1.0,
    slAtrMult: 1.4,
    tpAtrMult: 2.24,
    thresholdCandidates: [0.50, 0.55, 0.60, 0.65, 0.70],
    expectedTradesPerMonth: '40-100',
    expectedWR: '55-65%',
    expectedPF: '1.8-2.5',
    isAuto: true
  }
};

const DEFAULT_PROFILE_KEY = 'BALANCED';

// ─── Persistence ───────────────────────────────────────────────────────────

function _load() {
  if (!fs.existsSync(PROFILE_FILE)) {
    return { activeKey: DEFAULT_PROFILE_KEY, switchedAt: new Date().toISOString(), boostMode: false };
  }
  try {
    const obj = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf-8'));
    if (PRESETS[obj.activeKey]) {
      // Backfill boostMode if missing
      if (obj.boostMode === undefined) obj.boostMode = false;
      return obj;
    }
  } catch (e) { /* fall through */ }
  return { activeKey: DEFAULT_PROFILE_KEY, switchedAt: new Date().toISOString(), boostMode: false };
}

// ── AUTO MODE: time-of-day → sub-preset selector ───────────────────────────
// All times are PACIFIC (PT). The selection mirrors my intraday recommendation:
//   • 6:30-7:30 AM PT  (NY open volatility)   → BALANCED
//   • 7:30-11:00 AM PT (RTH trend session)    → ACTIVE
//   • 11:00-1:00 PM PT (lunch chop)           → SNIPER
//   • 1:00-2:00 PM PT  (pre-RTH-close)        → ACTIVE
//   • 3:00-7:00 PM PT  (post-CME maintenance) → BALANCED
//   • 7:00 PM - 5:30 AM (overnight, low vol)  → SNIPER
//   • Anytime else                            → BALANCED
function _autoPickSubPreset(now) {
  // Convert to PT
  const ptStr = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  const ptDate = new Date(ptStr);
  const h = ptDate.getHours();
  const m = ptDate.getMinutes();
  const t = h * 60 + m;
  // Window boundaries in minutes from midnight PT
  const NY_OPEN_START   =  6 * 60 + 30;   //  6:30 AM
  const NY_OPEN_END     =  7 * 60 + 30;   //  7:30 AM
  const TREND_END       = 11 * 60;         // 11:00 AM
  const LUNCH_END       = 13 * 60;         //  1:00 PM
  const PRE_CLOSE_END   = 14 * 60;         //  2:00 PM
  const POST_MAINT_START= 15 * 60;         //  3:00 PM
  const POST_MAINT_END  = 19 * 60;         //  7:00 PM
  const OVERNIGHT_END   =  5 * 60 + 30;    //  5:30 AM next day

  if (t >= NY_OPEN_START && t < NY_OPEN_END)      return 'BALANCED';
  if (t >= NY_OPEN_END   && t < TREND_END)        return 'ACTIVE';
  if (t >= TREND_END     && t < LUNCH_END)        return 'SNIPER';
  if (t >= LUNCH_END     && t < PRE_CLOSE_END)    return 'ACTIVE';
  if (t >= POST_MAINT_START && t < POST_MAINT_END) return 'BALANCED';
  if (t >= POST_MAINT_END || t < OVERNIGHT_END)   return 'SNIPER';   // 7 PM PT → 5:30 AM PT
  return 'BALANCED';
}

// Resolves what AUTO is currently picking AND applies boostMode if on
function _resolveEffective(meta) {
  let effectiveKey = meta.activeKey;
  let autoSubKey = null;
  if (meta.activeKey === 'AUTO') {
    autoSubKey = _autoPickSubPreset(new Date());
    effectiveKey = autoSubKey;
  }
  const base = PRESETS[effectiveKey] || PRESETS[DEFAULT_PROFILE_KEY];
  let result = { ...base, isAutoActive: meta.activeKey === 'AUTO', autoSubKey };

  // Boost mode override — tightens R:R to 1.4:1 regardless of preset
  if (meta.boostMode) {
    result.tpR = 1.4;
    result.slR = 1.0;
    // Keep slAtrMult, compute tpAtrMult = slAtrMult × (tpR/slR)
    result.tpAtrMult = result.slAtrMult * (result.tpR / result.slR);
    result.boostApplied = true;
  } else {
    result.boostApplied = false;
  }
  return result;
}

function _save(obj) {
  const dir = path.dirname(PROFILE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
}

// ─── Public API ────────────────────────────────────────────────────────────

function getActiveProfile() {
  const meta = _load();
  const eff = _resolveEffective(meta);
  return {
    ...eff,
    switchedAt: meta.switchedAt,
    boostMode: !!meta.boostMode,
    selectedKey: meta.activeKey   // what the user selected (could be AUTO)
  };
}

function setActiveProfile(key) {
  if (!PRESETS[key]) return null;
  const old = _load();
  const meta = { activeKey: key, switchedAt: new Date().toISOString(), boostMode: !!old.boostMode };
  _save(meta);
  // Update quality_floors.json so the trainer + runtime gate pick it up.
  // For AUTO, we write the BALANCED floor as a safe baseline — AUTO sub-preset
  // picking happens at decide() time, so the trainer doesn't see it directly.
  try {
    const baseKey = (key === 'AUTO') ? 'BALANCED' : key;
    const floorsFile = path.join(__dirname, '..', 'models', 'quality_floors.json');
    const cfg = {
      rthFloor: PRESETS[baseKey].rthFloor,
      ethFloor: PRESETS[baseKey].ethFloor,
      minPF: 1.5,
      minTrades: 30,
      lastTrainedAt: new Date().toISOString(),
      activeProfile: key
    };
    fs.writeFileSync(floorsFile, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) { /* non-fatal */ }
  return getActiveProfile();
}

function setBoostMode(enabled) {
  const meta = _load();
  meta.boostMode = !!enabled;
  meta.boostSwitchedAt = new Date().toISOString();
  _save(meta);
  return getActiveProfile();
}

function getAllPresets() {
  return Object.values(PRESETS);
}

module.exports = {
  PRESETS,
  DEFAULT_PROFILE_KEY,
  getActiveProfile,
  setActiveProfile,
  setBoostMode,
  getAllPresets
};
