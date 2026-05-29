@echo off
REM ─────────────────────────────────────────────────────────────────────────
REM Antigravity Gate 2 — Start Pattern Engine Flask Service
REM Starts the 7-pattern detector on http://localhost:3100
REM Called automatically by server.js when Gate 2 shadow mode is enabled.
REM ─────────────────────────────────────────────────────────────────────────

cd /d "D:\Google AntiGravity"
echo Starting Gate 2 Pattern Engine on port 3100...
python gate2\scripts\pattern_engine.py
pause
