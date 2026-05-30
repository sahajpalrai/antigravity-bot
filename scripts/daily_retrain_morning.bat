@echo off
REM ───────────────────────────────────────────────────────────────────────────
REM Antigravity v2 — Morning Full Retrain (9:00 PM PT)
REM
REM Runs 4 symbol retrains in PARALLEL (one node process per symbol).
REM Full 150-tree GBDT walkforward on all 16 bundles per symbol
REM (4 symbols × 16 bundles = 64 total: 2 sessions × 4 regimes × 2 dirs).
REM
REM Sequential was 3-7h; parallel on 8-core machine takes ~1.75h max.
REM Scheduled at 9:00 PM PT → bundles ready by ~10:45 PM, well before
REM the 5:00 AM server start and 6:30 AM RTH bell.
REM
REM Delegates to: scripts\retrain_parallel.ps1
REM Auto-rollback ON: bad retrains can never poison live behavior.
REM ───────────────────────────────────────────────────────────────────────────

setlocal
set PROJECT_DIR=D:\Google AntiGravity

powershell.exe -NonInteractive -ExecutionPolicy Bypass ^
    -File "%PROJECT_DIR%\scripts\retrain_parallel.ps1"

set RC=%ERRORLEVEL%
endlocal
exit /b %RC%
