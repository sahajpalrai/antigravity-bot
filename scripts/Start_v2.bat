@echo off
REM ───────────────────────────────────────────────────────────────────────────
REM Antigravity v2 — One-click server launcher
REM Double-click to start the bot in PAPER mode. Browser opens to dashboard.
REM
REM To run LIVE: edit .env and set TRADING_MODE=live, then run this.
REM To stop:    close this window (or Ctrl+C).
REM ───────────────────────────────────────────────────────────────────────────

title Antigravity v2 — PAPER
cd /d "D:\Google AntiGravity"

echo =====================================================
echo   ANTIGRAVITY v2  -  PAPER MODE
echo   Web:  http://localhost:3000
echo   NT8:  TCP 4000 (waiting for chart connections)
echo =====================================================
echo.

REM Open browser after a brief delay so it lands on a ready page
start "" /B cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"

REM Boot the server (foreground so you can see logs + Ctrl+C to stop)
node server.js

echo.
echo Server stopped. Press any key to close this window.
pause >nul
