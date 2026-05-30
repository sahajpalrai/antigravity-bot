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

REM Run the LightGBM trainer with auto-rollback + quality floors.
REM Floors raised 2026-05-28: CHOP models were 0-for-5 live (all SL).
REM RTH: require >=60% WR, PF>=1.30, Sharpe>=0.8
REM ETH: require >=58% WR, PF>=1.30, Sharpe>=0.8
REM LightGBM replaces the old node scripts\train.js (was hours; now ~7 min).
python scripts\train_lgbm.py --auto-rollback --rth-floor=0.60 --eth-floor=0.58 >> "%LOG_FILE%" 2>&1
set RETRAIN_RC=%ERRORLEVEL%

echo.                                                               >> "%LOG_FILE%"
echo ======================================                         >> "%LOG_FILE%"
echo Completed: %DATE% %TIME%                                       >> "%LOG_FILE%"
echo Exit code: %RETRAIN_RC%                                        >> "%LOG_FILE%"

REM Keep the last 30 days of logs (~60 runs at 2/day); prune older
forfiles /P "%LOG_DIR%" /M retrain_*.log /D -30 /C "cmd /c del @path" 2>nul

endlocal
exit /b %RETRAIN_RC%
