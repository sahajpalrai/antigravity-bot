@echo off
REM Antigravity v2 — premarket trading resume (5:30 AM PT, 1 hr before RTH open)
cd /d "D:\Google AntiGravity"
"C:\Program Files\nodejs\node.exe" scripts\resume_trading.js >> logs\resume_trading.log 2>&1
