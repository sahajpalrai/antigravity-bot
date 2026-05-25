@echo off
REM ───────────────────────────────────────────────────────────────────────────
REM One-time installer for the Antigravity v2 Weekly Retrain scheduled task.
REM Right-click → Run as administrator.
REM
REM Schedule: Every Sunday at 12:00 PM Pacific Time.
REM Auto-rollback ON: if any new model backtests WORSE than current, the
REM existing model is kept. Bad retrains can never poison Monday-morning live.
REM ───────────────────────────────────────────────────────────────────────────

echo Installing scheduled task: "Antigravity Weekly Retrain"
echo Source XML: %~dp0weekly_retrain.xml
echo.

schtasks /Create /XML "%~dp0weekly_retrain.xml" /TN "Antigravity Weekly Retrain" /F

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ============================================================
    echo  Installed. Next Sunday at 12:00 PM PT, the retrainer will run.
    echo  Logs: D:\Google AntiGravity\models\retrain_logs\
    echo.
    echo  Manage:
    echo    schtasks /Run    /TN "Antigravity Weekly Retrain"   ^(force run now^)
    echo    schtasks /Query  /TN "Antigravity Weekly Retrain" /V /FO LIST
    echo    schtasks /Delete /TN "Antigravity Weekly Retrain" /F  ^(remove^)
    echo ============================================================
) else (
    echo.
    echo Installation FAILED. Run this script "as administrator".
)

pause
