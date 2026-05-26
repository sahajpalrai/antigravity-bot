@echo off
REM Antigravity v2 — Daily Health Monitor
REM Runs once per day at 5:00 PM PT (after RTH close). Produces a concise
REM summary covering paper trade results, bundle drift, loss-streak warnings,
REM and retrain flags. Output appended to models/daily_monitor_history.json
REM and saved to models/monitor_logs/monitor_<timestamp>.log.

setlocal
set PROJECT_DIR=D:\Google AntiGravity
set LOG_DIR=%PROJECT_DIR%\models\monitor_logs

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

cd /d "%PROJECT_DIR%"
node scripts\daily_monitor.js
endlocal
exit /b %ERRORLEVEL%
