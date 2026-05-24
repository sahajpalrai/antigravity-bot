@echo off
title V1 Antigravity Smart Bot Launcher
color 0B

echo ====================================================================
echo             V1 ANTIGRAVITY SMART BOT - WINDOWS LAUNCHER             
echo ====================================================================
echo.

:: 1. Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is NOT installed on your Windows system!
    echo.
    echo Please follow these simple steps to install it:
    echo 1. Open your browser and go to: https://nodejs.org/
    echo 2. Download and run the recommended LTS Installer for Windows.
    echo 3. Once installed, double-click this run_bot.bat script again.
    echo.
    pause
    exit
)

echo [OK] Node.js runtime detected.
echo [INFO] Starting V1 Antigravity Smart Bot Server...
echo [INFO] Exposing local NT8 TCP Bridge on port 4000...
echo [INFO] Exposing web dashboard on port 3000...
echo.

:: 2. Auto-open the web browser to the dashboard after a 2 second delay
start "" http://localhost:3000

:: 3. Launch the Node.js server
node server.js

pause
