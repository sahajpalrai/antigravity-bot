@echo off
REM ───────────────────────────────────────────────────────────────────────────
REM Antigravity v2 — Afternoon Quick Retrain (2:10 PM PT)
REM
REM Runs 4 symbol retrains in PARALLEL with -Quick (50-tree GBDT).
REM Sequential was 60-75 min (overran 3:00 PM CME restart); parallel
REM finishes in ~20 min, well inside the 2:00–3:00 PM maintenance window.
REM
REM Delegates to: scripts\retrain_parallel.ps1 -Quick
REM ───────────────────────────────────────────────────────────────────────────

setlocal
set PROJECT_DIR=D:\Google AntiGravity

powershell.exe -NonInteractive -ExecutionPolicy Bypass ^
    -File "%PROJECT_DIR%\scripts\retrain_parallel.ps1" -Quick

set RC=%ERRORLEVEL%
endlocal
exit /b %RC%
