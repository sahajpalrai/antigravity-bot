# 🔬 2026-06-07 — ROOT-CAUSE FIX (owner: "fix the root cause not to disable")

**Owner pushed back on band-aid disables and on ES not trading. Did a data-driven
audit + backtest (no assumptions) for NQ & ES TREND_UP shorts. Two assumptions died.**

**Findings (365-day backtest, by year, 1 contract, $4 RT comm):**
| Bundle | Trades | WR | PF | Net/yr | 2025 | 2026 | Verdict |
|---|---|---|---|---|---|---|---|
| NQ short RAW (live) | 507 | 48% | 1.42 | +$72,372 | +$14.8k | +$57.6k | **KEEP RAW** |
| NQ short guarded | 165 | 58% | 2.45 | +$52,186 | +$13.4k | +$38.8k | guard cuts $20k |
| ES short RAW | 1530 | 40% | 1.10 | +$17,958 | +$210 ⚠️ | +$17.7k | fragile |
| ES short GUARDED | 453 | 44% | 1.47 | +$22,470 | +$11.1k | +$11.3k | **WINNER** |

- **NQ: left RAW.** Its TREND_UP shorts are robustly profitable both years (the live
  −$1,363 on 2026-06-07 was normal variance — same size as backtest SL stops). The
  exhaustion guard would *cut* profit, so it is NOT applied to NQ. No change to NQ.
- **ES: the DISABLE was the bug.** `ES_*_TREND_UP_short` was BOTH disabled AND guarded
  — the disable nullified the guard, so ES never shorted up-trends → ES sat flat in
  every up-trend (owner's "ES takes no trade"). **Fix = REMOVE the disable** so the
  already-validated exhaustion guard runs. Guarded ES short is robust (+$22k/yr, both
  years +$11k) vs raw (2025 only +$210).

**Changes (all live, hot-reloaded — no restart):**
| File | Change |
|---|---|
| `models/disabled_bundles.json` | **Removed** `ES_RTH_TREND_UP_short` + `ES_ETH_TREND_UP_short`. (NQ_TREND_UP_long + GC_TREND_UP_long stay disabled — separate.) |
| `models/exhaust_guard.json` | Added explicit `symbols:['ES']` (NQ tested + excluded). |
| `lib/decisionEngine.js` | Guard scope now symbol-configurable (`_eg.symbols`, env `EXHAUST_SYMBOLS`); backtest-only `IGNORE_DISABLED=1` to measure disabled bundles. Behavior unchanged for the live (ES) path. |

**Net effect:** ES trades up-trends again (guarded, robust). NQ untouched (already
profitable). ZERO new disables — the fix removed one. Do not re-add the ES short
disable; it silences ES and nullifies the guard.

---

# 🚨 2026-06-04 — EMERGENCY REVERT (owner-authorized after NQ −$4,445 live loss)

**Owner (mrrai) authorized this revert directly:** _"we have very big loss please
fix the issue... if you need to revert the code yesterday do it and find what code
is causing the loss... revert it to make it profitable."_

**Root cause found:** NQ realized −$4,445 (ES fine at +$25). The single NQ entry on
2026-06-04 was `TREND_UP Long` = `NQ_TREND_UP_long`, **the proven bleeder (PF ~1.17)
that got re-enabled when restrictions were cleared** on the owner's "no restrictions"
request — fired at **2 contracts** into a choppy reversing tape. −$1,803 that day on
top of −$2,642 the day before. The daily −$1,500 cap worked (blocked further NQ
entries) but at 2 contracts the last open trade overshot to −$1,803.

**Reverted (both PERMANENT — survive restart + retrain):**
| What | From | To | Where it lives |
|---|---|---|---|
| Restrictions (kill-switch) | EMPTY (bleeders ON) | **5 bleeders re-disabled** = the proven PF-1.74 SELECTIVE config | `models/disabled_bundles.json` (hot-reloaded, retrain never touches it) |
| NQ contract size | 2 | **1** (halves per-trade risk + tightens cap overshoot) | `portfolio_state.json` on disk (field persists; backfill won't override) |

Re-disabled bundles: `NQ_RTH_TREND_UP_long`, `NQ_ETH_TREND_UP_long`,
`ES_RTH_TREND_UP_short`, `ES_ETH_TREND_UP_short`, `GC_RTH_TREND_UP_long`.

**Left intact (validated-profitable, NOT the loss cause):** trail 2.0, ES exhaust
gate, session_quality, daily cap, NQ DD buffer, NQ floor 0.50. ES stays at 2 contracts
(profitable). To re-enable any bleeder or raise NQ back to 2, a fresh backtest with
current fixes must prove it — and the owner must re-validate.

---

# 🔒 CHANGE RECORD — 2026-06-02 (OWNER-LOCKED)

**These changes were validated with the owner (mrrai) on 2026-06-02.**
**DO NOT modify, revert, or retune any item below — by hand OR by the nightly
retrain — without the owner's explicit re-validation.** Each item lists the
exact file, what changed, why, and the validated number.

Rollback safety: every item is committed to git + pushed to GitHub
(`sahajpalrai/antigravity-bot`, branch `main`). Reversible by reverting the
named commit or restoring the named file.

---

## ⭐ LIVE-AUDIT FIXES (PM session 2026-06-02 — owner-approved, all PERMANENT)

Two read-only workflows (ES-fix + full live audit, 12 agents) → owner authorized
these. None can be reverted by the retrain (it only writes bundle model JSONs).

| # | File | Change | Validated (3yr, slippage) |
|---|---|---|---|
| **★1** | `server.js` (3 fire sites) | **`atrTrailingMultiplier` 1.0 → 2.0** | **Biggest win.** Live exits were PF 1.37/+$1.84M (1.0 trail cut winners). 2.0 → **PF 1.58 / +$2.40M (+$560k) + lower drawdown.** Commit `7ca423b`. |
| 2 | `lib/decisionEngine.js` + `models/exhaust_guard.json` (enabled) | ES exhaustion gate: ES TREND_UP shorts only fire at ADX≥30 & ≥4 ATR over VWAP | ES_TREND_UP_short −$46k/PF0.92 → +$24k/PF1.21, positive every year. Commit `d206577`/`a393f9d`. |
| 3 | `models/session_quality.json` | REMOVED the +0.06 NQ_ETH penalty (it was throttling the +$644k best engine) | un-throttles NQ overnight; +$481k portfolio combined w/ #2. |
| 4 | `lib/decisionEngine.js` | daily −$1500 cap MICRO-mode key bug (familyMiniSymbol on read+write) | restores the circuit breaker in MICRO mode. |

**Bigger-3 investigation results (env-gated tooling in `backtest_gates.js` + `decisionEngine.js`):**
- dir_guard → no benefit, **stays OFF**.
- threshold-cap → raising it cuts profit, **stays 0.58** (audit hypothesis disproved).
- chop_guard → **DECIDED 2026-06-03: KEEP OFF — DO NOT RE-TRY.** A 4-agent validation workflow
  (incl. adversarial check) proved the guarded TREND set is **+$1.24M / PF 1.385 PROFITABLE** and
  **every** floor (fixed 0.30/0.40/0.45 AND every forward proxy: recent-SL streak, regime-flip count,
  entry-ER, per-day circuit breaker) **cuts net-POSITIVE trades**. The blunt 0.34 cost −$430k for
  +0.16 PF. It fights the owner's "more trades on the profit side" goal, so it stays OFF. The AUTO
  vol-scaled floor (`base 0.34 + 0.30×(atr_pctile−0.5)`, clamp 0.22–0.42) is the right *design* but its
  benefit is UNPROVEN (no dataset carries true live per-entry ER) — only build if a live-ER backtest
  confirms the high-vol-chop band is net-negative. The −$1,500 cap (below) is the real disaster-day
  protection and cuts ZERO normal trades.

## ⭐⭐ 2026-06-03 — SAFETY FIXES (after the NQ −$2,642 whipsaw day)

| File | Change | Why |
|---|---|---|
| `lib/decisionEngine.js` | **Daily −$1,500 cap now mirrors NT8's REAL realized P&L** (was the bot's reconstructed ledger which under-counted by $836, letting the cap overshoot to −$2,642). `seedDailyPnLFromNt8` runs every METRICS, tracks `nt8Realized − dayAnchor`, persisted. | Caps every disaster day at −$1,500 accurately. Commit `8d036ab`. |
| `lib/paperEngine.js` | **NQ trailing-DD buffer 2,500 → 6,000** (`DD_BY_SYMBOL`). NQ "won itself into a lockout": a winning run ratcheted the floor up, a pullback left $263 room < its stop, sizer returned 0. | NQ trades reliably; reset-proof. Commit `9ca3541`. |
| `lib/decisionEngine.js` + `public/js/app.js` | **Read-only CHOP INDICATOR** on dashboard cards (live 20-bar efficiency ratio + CHOPPY/MIXED/CLEAN + vol rank). | Eyes-only visibility — NEVER blocks a trade. |
- BE/trail modeling → built into the harness so PF is now a true live mirror (led to ★1).

**Honest baseline:** the real live-exit number (post all fixes) is **PF ~1.58 / +$2.40M** with the 2.0 trail — earlier static-bracket figures (1.5-1.74) were optimistic.

**Still OPEN (owner action):** CL + GC get zero live bars → add those 2 charts in NinjaTrader to bring online your 2 best symbols (PF 2.44 / 2.37).

---

## A. RELIABILITY (the "feed/retrain keeps dying" fixes)

| # | File | Change | Why |
|---|---|---|---|
| A1 | `lib/nt8Bridge.js` | TCP keepalive + 120s idle reaper on each NT8 socket; Telegram alert on connect/disconnect; stale-bar monitor (>4min no bars during market hrs) | Zombie half-open sockets left the bot blind for hours. Commit `caffce0`. |
| A2 | `scripts/server_watchdog.js` + `restart_server.ps1` + `.bat` + Task `Antigravity v2 Server Watchdog` (every 3 min) | Auto-restarts the brain within 3 min if the process dies. Commit `7180067`. |
| A3 | Task Scheduler | Disabled V4 `NQ Bot - Auto Start on Login`. **V5 tasks still need owner to run the admin command** (see below). **V6 untouched, per owner.** | Removed morning contention. |

**Pending owner action (admin):** disable the two V5 tasks —
```
Disable-ScheduledTask -TaskName 'NQ V5 PA+ML Retrain 445AM'
Disable-ScheduledTask -TaskName 'NQ V5 Sunday Pre-Open Restart 255PM'
```

---

## B. STRATEGY — Gate 1 profitability (3yr backtest, **realistic 1-tick slippage**)

| # | File | Change | Validated result |
|---|---|---|---|
| B1 | `scripts/backtest_gates.js` | Added `SLIP_TICKS` slippage model (entry+stops slip against you; TP at limit) | Edge survives costs: PF 1.61→1.55. Commit `eaa183f`. |
| B2 | `models/session_quality.json` → `NQ=F_ETH: +0.06` | NQ overnight must clear a higher bar (suppress churn) | Portfolio PF 1.67→**2.09**, WR 53→57%, NQ drawdown halved. Commit `45bfe66`. |
| B3 | `models/session_quality.json` → all `*_RTH: -0.02` | RTH fires AT the trained edge (more daytime trades) | RTH 2.84→**4.32 trades/day (+52%)**, PF 2.09→2.04, +$100k. Commit `fff421f`. |
| B4 | `models/quality_floors.json` → NQ floor 0.60→0.50 | Un-bench NQ's profitable low-WR/high-PF specialists (CHOP, TREND_DOWN long, VOL_EXP long) — NQ was starved while ES/CL/GC had overrides | **VALIDATED + DEPLOYED.** NQ trades **5,478 vs ~1,840** (3×). Portfolio 8,369t/PF2.04/$1.67M → **11,645t / PF 1.74 / +$1.92M** (+$255k, NQ fully active; PF eased 2.04→1.74 by design — owner chose NQ activity). |

---

## B5. NQ EXECUTION FIX (the "NQ decides but doesn't trade in NT8" bug)

**Root cause (two layers):** (1) NQ's quality floor benched its specialists →
fixed in B4. (2) Then the **position sizer returned 0 for NQ** because the NQ
sim account (`SimHA candles`) had ratcheted its trailing drawdown floor up,
leaving only ~$398 of room — less than one NQ contract's stop. The bot mirrors
the real NT8 account, so it correctly refused (one trade could breach the floor).

**Fix:** Per-symbol account reset (`/api/reset-accounts` scope=symbol) on NQ + ES.
Re-bases the drawdown floor at the current balance → fresh room (~$52k buffer on
the sim/eval accounts). **PROVEN:** manual test-fire → `BUY,NQ=F,1` broadcast →
NT8 filled `Long 1 @ 30751.25`. NQ now executes on the chart.

- **Mini:** NQ + ES both trade now (ES always did; NQ fixed). ✅
- **Micro:** MNQ/MES have full room but are disabled in MINI mode. To use micros,
  switch contract mode to MICRO **and** attach MNQ/MES charts in NT8.
- **NOTE:** the reset left a LOOSE drawdown buffer (peak didn't re-ratchet, floor
  ~$47.5k). Fine for sim evaluation (won't halt on drawdown). To restore a strict
  trailing-$2,500 DD, ask — it's a one-line re-base, but it can re-lock NQ on a
  bad run.

## C. BUILT BUT LEFT OFF (data rejected them — do not enable without re-validation)

| File | State | Why off |
|---|---|---|
| `models/dir_guard.json` | `enabled: false` | EMA9 directional guard — didn't improve PF in A/B. |
| `models/chop_guard.json` | `enabled: false` | Efficiency-ratio chop guard — A/B rejected. |

---

## D. KNOWN GAPS — owner aware, fix planned (NOT yet done)

- **Recent-trade-history dashboard panel** is empty: removing the paper engine
  left no per-trade source (NT8 sends only aggregate P&L). Fix = small `.cs`
  emit per closed trade. **Planned, not yet built.**
- **TREND_UP long/short symmetry**: `NQ_TREND_UP_long` and `ES_TREND_UP_short`
  remain disabled (proven bleeders in replay). Re-enable only if a fresh
  backtest with current fixes proves them profitable. **Under evaluation.**
- **Systemic benched bundles**: every symbol has high-PF/low-WR bundles benched
  by win-rate floors. Candidate fix = PF-based admit rule. **Not yet built.**

---

## 🔒 LOCKED FILES — no edits without owner validation
- `models/session_quality.json`  (B2, B3)
- `models/quality_floors.json`    (B4 + the ES/CL/GC overrides)
- `models/disabled_bundles.json`  (the kill-switch list)
- `models/dir_guard.json`, `models/chop_guard.json` (stay OFF)
- The session-quality + floor logic in `lib/decisionEngine.js`
- `lib/nt8Bridge.js` robustness block (A1)

_The nightly retrain already cannot touch these (it only writes bundle models).
This file is the human contract: ask the owner before changing any of them._
