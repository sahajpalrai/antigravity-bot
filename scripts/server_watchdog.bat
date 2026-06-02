@echo off
REM Antigravity v2 — Server Watchdog (runs every 3 min via Task Scheduler)
REM Restarts the brain if it's dead or the NT8 feed has been stale >10min.
cd /d "D:\Google AntiGravity"
"C:\Program Files\nodejs\node.exe" scripts\server_watchdog.js >> logs\server_watchdog.log 2>&1
