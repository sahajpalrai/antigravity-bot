@echo off
REM ───────────────────────────────────────────────────────────────────────────
REM Antigravity v2 — Daily Walkforward Retrain
REM Runs TWICE a day: 04:30 AM PT (pre-market) and 14:30 PM PT (post-CME-maint).
REM Uses --auto-rollback so any new model that backtests WORSE than the existing
REM one is automatically reverted — bad retrains cannot poison live behavior.
REM
REM Install via: scripts\install_daily_retrain.bat (Run as administrator).
REM ───────────────────────────────────────────────────────────────────────────

setlocal
set PROJECT_DIR=D:\Google AntiGravity
set LOG_DIR=%PROJECT_DIR%\models\retrain_logs

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

REM Timestamped log filename: retrain_2026-05-25_12-00-00.log
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value ^| find "="') do set DT=%%I
set TS=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%_%DT:~8,2%-%DT:~10,2%-%DT:~12,2%
set LOG_FILE=%LOG_DIR%\retrain_%TS%.log

echo === Antigravity v2 Daily Retrain ===                          >> "%LOG_FILE%"
echo Started: %DATE% %TIME%                                         >> "%LOG_FILE%"
echo Project: %PROJECT_DIR%                                         >> "%LOG_FILE%"
echo ======================================                         >> "%LOG_FILE%"

cd /d "%PROJECT_DIR%"

REM Run the trainer with auto-rollback enabled
node scripts\train.js --auto-rollback                              >> "%LOG_FILE%" 2>&1
set RETRAIN_RC=%ERRORLEVEL%

echo.                                                               >> "%LOG_FILE%"
echo ======================================                         >> "%LOG_FILE%"
echo Completed: %DATE% %TIME%                                       >> "%LOG_FILE%"
echo Exit code: %RETRAIN_RC%                                        >> "%LOG_FILE%"

REM Keep the last 30 days of logs (~60 runs at 2/day); prune older
forfiles /P "%LOG_DIR%" /M retrain_*.log /D -30 /C "cmd /c del @path" 2>nul

endlocal
exit /b %RETRAIN_RC%
