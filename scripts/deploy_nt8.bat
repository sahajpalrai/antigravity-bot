@echo off
REM ───────────────────────────────────────────────────────────────────────────
REM Antigravity v2 — Deploy NT8 strategy file
REM Copies AntigravityBotBridge.cs from the source repo to NT8's strategies
REM folder. After running, recompile in NT8:
REM   Tools -> Edit NinjaScript -> Strategy -> select AntigravityBotBridge ->
REM   press F5 -> wait for "Compile succeeded".
REM Then remove the strategy from any open chart and re-add it.
REM
REM Run this every time the .cs source changes (BE/trail, Brain Panel, etc.).
REM ───────────────────────────────────────────────────────────────────────────

set SRC=D:\Google AntiGravity\NT8_Bridge\AntigravityBotBridge.cs
set DEST=C:\Users\mrrai\Documents\NinjaTrader 8\bin\Custom\Strategies\AntigravityBotBridge.cs

echo Source: %SRC%
echo Dest:   %DEST%
echo.

if not exist "%SRC%" (
    echo ✗ Source file missing.
    pause
    exit /b 1
)

if not exist "C:\Users\mrrai\Documents\NinjaTrader 8\bin\Custom\Strategies\" (
    echo ✗ NT8 Strategies directory not found. Is NT8 installed for this user?
    pause
    exit /b 1
)

copy /Y "%SRC%" "%DEST%"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ============================================================
    echo  Deployed AntigravityBotBridge.cs to NT8.
    echo.
    echo  NEXT STEPS in NT8:
    echo    1. Tools -^> Edit NinjaScript -^> Strategy
    echo    2. Select "AntigravityBotBridge"
    echo    3. Press F5 to compile
    echo    4. Wait for "Compile succeeded"
    echo    5. On each chart using the strategy:
    echo         right-click -^> Strategies -^> remove
    echo         then re-add AntigravityBotBridge
    echo ============================================================
) else (
    echo.
    echo ✗ Copy failed. Is NT8 running and locking the file?
    echo   Try closing NT8 first, then re-run this script.
)

pause
