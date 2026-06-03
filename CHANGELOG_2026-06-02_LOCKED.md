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
- chop_guard → PF 1.49→1.65 but −$430k = **OWNER DECISION PENDING** (efficiency vs dollars).
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
