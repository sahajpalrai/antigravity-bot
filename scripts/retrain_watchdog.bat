@echo off
REM Antigravity v2 — Retrain Watchdog (runs 9:45 PM PT, 45 min after the 9 PM full retrain)
REM Verifies the nightly retrain ran + finished; self-heals (re-runs) + Telegrams if not.
cd /d "D:\Google AntiGravity"
"C:\Program Files\nodejs\node.exe" scripts\retrain_watchdog.js >> logs\retrain_watchdog.log 2>&1
