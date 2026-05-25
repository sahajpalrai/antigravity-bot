@echo off
REM ───────────────────────────────────────────────────────────────────────────
REM One-time installer for the Antigravity v2 Daily Retrain scheduled task.
REM Right-click → Run as administrator.
REM
REM Schedule: EVERY DAY at 04:30 AM PT and 14:30 PM PT (two daily triggers).
REM   - 04:30 AM PT: 30 min before pre-market warmup
REM   - 14:30 PM PT: 30 min after CME daily maintenance window closes
REM Auto-rollback ON: if any new model backtests WORSE than current, the
REM existing model is kept. Bad retrains can never poison live behavior.
REM ───────────────────────────────────────────────────────────────────────────

REM Clean up the old weekly task if it was previously installed
schtasks /Delete /TN "Antigravity Weekly Retrain" /F >nul 2>&1

echo Installing scheduled task: "Antigravity Daily Retrain"
echo Source XML: %~dp0daily_retrain.xml
echo.

schtasks /Create /XML "%~dp0daily_retrain.xml" /TN "Antigravity Daily Retrain" /F

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ============================================================
    echo  Installed. Retrains run every day at 04:30 AM and 14:30 PM PT.
    echo  Logs: D:\Google AntiGravity\models\retrain_logs\
    echo.
    echo  Manage:
    echo    schtasks /Run    /TN "Antigravity Daily Retrain"   ^(force run now^)
    echo    schtasks /Query  /TN "Antigravity Daily Retrain" /V /FO LIST
    echo    schtasks /Delete /TN "Antigravity Daily Retrain" /F  ^(remove^)
    echo ============================================================
) else (
    echo.
    echo Installation FAILED. Run this script "as administrator".
)

pause
