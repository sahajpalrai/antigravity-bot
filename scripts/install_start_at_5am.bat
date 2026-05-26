@echo off
REM ───────────────────────────────────────────────────────────────────────────
REM One-time installer for Antigravity v2 — Auto-Start at 5 AM PT daily
REM Right-click → Run as administrator.
REM
REM Schedule:
REM   - 04:30 AM PT  →  Daily retrain (separate task: install_daily_retrain.bat)
REM   - 05:00 AM PT  →  THIS TASK: boots node server.js + opens dashboard
REM   - 06:30 AM PT  →  RTH market open, bot starts firing on bars
REM
REM Server boots in PAPER mode unless .env has TRADING_MODE=live.
REM WakeToRun is enabled so the PC will wake from sleep at 5 AM if asleep.
REM ───────────────────────────────────────────────────────────────────────────

echo Installing scheduled task: "Antigravity v2 Auto-Start 5AM"
echo Source XML: %~dp0start_v2_5am.xml
echo.

schtasks /Create /XML "%~dp0start_v2_5am.xml" /TN "Antigravity v2 Auto-Start 5AM" /F

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ============================================================
    echo  Installed. Tomorrow at 05:00 AM PT, the server will boot.
    echo  Dashboard auto-opens at http://localhost:3000
    echo.
    echo  Manage:
    echo    schtasks /Run    /TN "Antigravity v2 Auto-Start 5AM"  ^(force boot now^)
    echo    schtasks /Query  /TN "Antigravity v2 Auto-Start 5AM" /V /FO LIST
    echo    schtasks /Delete /TN "Antigravity v2 Auto-Start 5AM" /F  ^(remove^)
    echo.
    echo  Recommended companion task:
    echo    Run scripts\install_daily_retrain.bat too — schedules the 4:30 AM
    echo    + 2:30 PM daily retrain so models stay fresh.
    echo ============================================================
) else (
    echo.
    echo Installation FAILED. Run this script "as administrator".
)

pause
