@echo off
REM Antigravity v2 -- Gate 2 Shadow Watchdog (every 30 min)
REM Health-checks the shadow log, harvests would-be trades into a persistent
REM ledger, scores Gate 2's shadow P&L vs the go-live bar, Telegrams on stale
REM shadow or when Gate 2 first qualifies for a 1-contract live test.
cd /d "D:\Google AntiGravity"
"C:\Program Files\nodejs\node.exe" scripts\gate2_shadow_watchdog.js >> logs\gate2_shadow_watchdog.log 2>&1
