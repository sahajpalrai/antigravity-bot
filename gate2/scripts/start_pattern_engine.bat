@echo off
REM ─────────────────────────────────────────────────────────────────────────
REM Antigravity Gate 2 — Pattern Engine launcher (port 3100)
REM
REM The pattern engine is a STDLIB-ONLY Python HTTP service (no Flask/pandas/numpy
REM despite the older docstring) — so any interpreter runs it. Pinned to
REM C:\Python314 for consistency. NO 'pause' so it can run unattended.
REM
REM You normally DON'T need to run this by hand: the gate2 shadow watchdog
REM (scripts\gate2_shadow_watchdog.js, every 5 min) auto-starts AND restarts it.
REM This .bat is for a manual foreground start when debugging.
REM ─────────────────────────────────────────────────────────────────────────
cd /d "D:\Google AntiGravity"
set PY=C:\Python314\python.exe
if not exist "%PY%" set PY=python
echo Starting Gate 2 Pattern Engine on port 3100 (Ctrl-C to stop)...
"%PY%" gate2\scripts\pattern_engine.py
