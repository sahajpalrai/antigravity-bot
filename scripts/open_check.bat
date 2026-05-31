@echo off
REM ---------------------------------------------------------------------------
REM Antigravity v2 — one-time market-open health check (Telegram verdict)
REM Scheduled ONCE at 3:05 PM PT. Confirms live bars are flowing post-open.
REM ---------------------------------------------------------------------------
cd /d "D:\Google AntiGravity"
"C:\Program Files\nodejs\node.exe" scripts\open_check.js >> logs\open_check.log 2>&1
