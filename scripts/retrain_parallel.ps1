#Requires -Version 5.1
# ============================================================================
# Antigravity v2 -- LightGBM Retrain Orchestrator
# Usage: .\retrain_parallel.ps1 [-Quick] [-DryRun]
#
# Runs a single Python LightGBM trainer for all 4 symbols (sequential
# inside the trainer, but each symbol only takes ~1-2 min).
# Total runtime: ~7 min full / ~3 min quick - no parallelism needed.
#
# Replaced the old 4x parallel node train.js approach:
#   Old: 4 node processes, 1.75h full / 20min quick  (O(n^2) JS GBDT)
#   New: 1 python process, ~7min full / ~3min quick  (LightGBM C++)
# ============================================================================
param(
    [switch]$Quick,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$projectDir = 'D:\Google AntiGravity'
$logDir     = "$projectDir\models\retrain_logs"
$modeLabel  = if ($Quick) { 'quick' } else { 'full' }
$ts         = Get-Date -Format 'yyyyMMdd_HHmm'
$startTime  = Get-Date

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }

# -- RTH Guard: warn if started during 6:30 AM - 2:00 PM PT -----------------
try {
    $tz     = [System.TimeZoneInfo]::FindSystemTimeZoneById('Pacific Standard Time')
    $nowPT  = [System.TimeZoneInfo]::ConvertTime((Get-Date), $tz)
    $minsPT = $nowPT.Hour * 60 + $nowPT.Minute
    $inRTH  = ($minsPT -ge 390) -and ($minsPT -lt 840)   # 6:30 AM - 2:00 PM PT
    if ($inRTH) {
        Write-Warning ("RTH WARNING: It is " + $nowPT.ToString('HH:mm') +
                       " PT -- model files will overwrite while the bot may be live trading.")
    }
} catch { }

# -- Summary log helper ------------------------------------------------------
$sumLog = "$logDir\par_${modeLabel}_${ts}_summary.log"
function Log([string]$msg) {
    Write-Host $msg
    $msg | Out-File -FilePath $sumLog -Append -Encoding utf8
}

Log ("=== Antigravity v2 LightGBM " + $modeLabel.ToUpper() + " Retrain ===")
Log ("Started : " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Log ("Symbols : NQ=F, ES=F, CL=F, GC=F  (all in one Python process)")
Log ("Quick   : " + $Quick + "  |  DryRun: " + $DryRun)
Log ""

# -- Build LightGBM trainer args ---------------------------------------------
$pyArgs = [System.Collections.ArrayList]@(
    'scripts/train_lgbm.py',
    '--auto-rollback',
    '--rth-floor=0.60',
    '--eth-floor=0.58',
    '--pf-floor=1.30',
    '--sharpe-floor=0.80',
    '--skip-chop'
)
if ($Quick) { [void]$pyArgs.Add('--quick') }

$outLog = "$logDir\lgbm_${modeLabel}_${ts}.log"
$errLog = "$logDir\lgbm_${modeLabel}_${ts}.err"

Log ("python " + ($pyArgs -join ' ') + "  ->  " + (Split-Path $outLog -Leaf))

if ($DryRun) {
    Log ''
    Log 'DRY RUN -- no process started. Script would have launched the above.'
    exit 0
}

# -- Launch single Python process (all 4 symbols, ~7 min full / ~3 min quick) -
$proc = Start-Process `
    -FilePath         'python' `
    -ArgumentList     $pyArgs `
    -WorkingDirectory $projectDir `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError  $errLog `
    -PassThru `
    -WindowStyle      Hidden

Log ("PID " + $proc.Id + " - waiting for completion...")
$proc.WaitForExit()

$elapsedMin = [math]::Round(((Get-Date) - $startTime).TotalMinutes, 1)
$rc         = $proc.ExitCode

# -- Parse SUMMARY line from LightGBM log ------------------------------------
$deployed = 0; $rejected = 0; $rolledBack = 0
$internalLog = Get-ChildItem $logDir -Filter "lgbm_*.log" |
    Where-Object { $_.LastWriteTime -gt $startTime } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if ($internalLog) {
    $txt = Get-Content $internalLog.FullName -Raw -ErrorAction SilentlyContinue
    if ($txt) {
        $m = [regex]::Match($txt, 'deployed=(\d+)')
        if ($m.Success) { $deployed  = [int]$m.Groups[1].Value }
        $m = [regex]::Match($txt, 'rejected=(\d+)')
        if ($m.Success) { $rejected  = [int]$m.Groups[1].Value }
        $m = [regex]::Match($txt, 'rolled_back=(\d+)')
        if ($m.Success) { $rolledBack = [int]$m.Groups[1].Value }
    }
}

# -- Results summary ---------------------------------------------------------
Log ""
Log ("=== Results (elapsed: " + $elapsedMin + " min) ===")
$status = if ($rc -eq 0) { 'PASS' } else { ("FAIL rc=" + $rc) }
Log ("{0,-12} deployed={1,2}  rejected={2,2}  rolled_back={3,2}" `
    -f $status, $deployed, $rejected, $rolledBack)

# Check stderr
if (Test-Path $errLog) {
    $errSize = (Get-Item $errLog).Length
    if ($errSize -eq 0) {
        Remove-Item $errLog -Force -ErrorAction SilentlyContinue
    } else {
        Log ("  !! STDERR non-empty (" + $errSize + " bytes): " + $errLog)
    }
}

Log ""
Log ("Completed : " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Log ("Exit code : " + $rc)

# -- Prune old parallel logs (keep 30 days) ----------------------------------
try {
    $cutoff = (Get-Date).AddDays(-30)
    Get-ChildItem $logDir -Filter 'par_*' |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem $logDir -Filter 'lgbm_*' |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        Remove-Item -Force -ErrorAction SilentlyContinue
} catch { }

exit $rc
