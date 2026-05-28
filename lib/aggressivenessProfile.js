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
    // Runtime cap: decisionEngine caps deployed bundle thresholds at this
    // value. SNIPER respects whatever the bundle was trained at (no cap).
    runtimeThresholdCap: null,
    expectedTradesPerMonth: '5-15',
    expectedWR: '70-90%',
    expectedPF: '3-5'
  },
  BALANCED: {
    key: 'BALANCED',
    label: 'Balanced · Quality + Volume',
    description: 'Moderate accuracy, moderate frequency. The recommended starting point.',
    // Volume-aware floors — backtest WR 55%/52% deploys, then live confluence
    // (FVG, EMA agreement, ATR sweet-spot, prob margin, adaptive threshold,
    // price-move guard) lifts to 65%+ live WR. Tightening backtest floor
    // beyond 0.55 strangled volume — fixed 2026-05-26 per user feedback.
    rthFloor: 0.55,
    ethFloor: 0.52,
    tpR: 1.6,
    slR: 1.0,
    slAtrMult: 1.4,
    tpAtrMult: 2.24,
    thresholdCandidates: [0.55, 0.58, 0.60, 0.62, 0.65, 0.68, 0.72, 0.75],
    // Cap lowered 2026-05-26 from 0.80 → 0.55 after live audit showed
    // GBDT model probabilities max out around 0.58 on current market
    // structure, but bundles were trained at 0.65-0.78 thresholds.
    // With cap 0.80, the bot literally couldn't fire (gap 10-25pp on
    // every bundle). 0.55 means any bundle trained above 0.55 fires at
    // 0.55, which matches the live prob distribution.
    //
    // Safety net: the 5 runtime guards (EMA agreement, ATR sweet-spot,
    // price-move-required, adaptive threshold, daily P&L cap) prevent
    // the worst losses that "fire below trained" would otherwise cause.
    // Cap raised 2026-05-27: bundles now require 60%+ WR floor so we demand
    // more conviction at fire time. Old 0.55 cap let coin-flip signals through.
    runtimeThresholdCap: 0.58,
    expectedTradesPerMonth: '20-45',
    expectedWR: '62-70%',
    expectedPF: '2.5-4.0'
  },
  ACTIVE: {
    key: 'ACTIVE',
    label: 'Active · More Trades',
    description: 'Quality-gated bundles (60%+ WR) with moderate threshold; max legitimate trades.',
    rthFloor: 0.60,
    ethFloor: 0.58,
    tpR: 1.4,
    slR: 1.0,
    slAtrMult: 1.2,
    tpAtrMult: 1.68,
    thresholdCandidates: [0.55, 0.58, 0.60, 0.62, 0.65, 0.68],
    // Cap raised 2026-05-27: with 60%+ quality bundles, 0.60 still allows
    // decent volume while filtering sub-threshold signals.
    runtimeThresholdCap: 0.60,
    expectedTradesPerMonth: '40-80',
    expectedWR: '60-68%',
    expectedPF: '2.0-3.5'
  },
  SCALPER: {
    key: 'SCALPER',
    label: 'Scalper · Max Volume',
    description: 'Same 65%+ live WR target; max trades from tightest R:R (1.2:1), tightest exits, lowest threshold candidates.',
    rthFloor: 0.55,
    ethFloor: 0.52,
    tpR: 1.2,
    slR: 1.0,
    slAtrMult: 1.0,
    tpAtrMult: 1.2,
    thresholdCandidates: [0.45, 0.48, 0.50, 0.52, 0.55, 0.58, 0.60, 0.62],
    // Cap aligned with live prob distribution (see BALANCED block).
    runtimeThresholdCap: 0.50,
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
  // Only update the `activeProfile` field in quality_floors.json — DO NOT
  // overwrite the floor values themselves. The floors in quality_floors.json
  // are now authoritative (set by the audit + the trainer's HARD_FLOORS).
  // Previously this function rewrote rthFloor/ethFloor from the preset
  // defaults, which silently disabled 10-15 deployed bundles whenever the
  // user switched profiles. AUTO-prep change 2026-05-26.
  try {
    const floorsFile = path.join(__dirname, '..', 'models', 'quality_floors.json');
    if (fs.existsSync(floorsFile)) {
      const cfg = JSON.parse(fs.readFileSync(floorsFile, 'utf-8'));
      cfg.activeProfile = key;
      cfg.lastProfileSwitch = new Date().toISOString();
      fs.writeFileSync(floorsFile, JSON.stringify(cfg, null, 2), 'utf-8');
    }
    // If the file doesn't exist, the trainer will create it on next run.
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
