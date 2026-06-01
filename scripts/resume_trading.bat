@echo off
REM Antigravity v2 — morning trading resume (6:00 AM PT, 30 min before RTH open)
cd /d "D:\Google AntiGravity"
"C:\Program Files\nodejs\node.exe" scripts\resume_trading.js >> logs\resume_trading.log 2>&1
