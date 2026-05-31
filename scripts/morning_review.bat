@echo off
REM ---------------------------------------------------------------------------
REM Antigravity v2 — Morning honest-numbers review (post-retrain auto-apply)
REM Scheduled DAILY 4:00 AM. Runs after the 9 PM purged-CV full retrain.
REM Reviews honest NQ-long performance, force-enables buckets that clear the
REM guardrails (PF>=1.5, WR>=0.45, trades>=40), commits + Telegrams.
REM Changes take effect at the 5 AM server auto-start (the control point).
REM ---------------------------------------------------------------------------
cd /d "D:\Google AntiGravity"
"C:\Program Files\nodejs\node.exe" scripts\morning_review.js >> logs\morning_review_task.log 2>&1
