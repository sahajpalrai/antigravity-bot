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
# ============================================================================
# BULLETPROOF PREFLIGHT -- self-healing so the retrain can NEVER silently die.
# ============================================================================
# History: nightly retrain failed 2026-06-02..05 from TWO stacked root causes:
#   (1) bare 'python' in the task context resolved to an interpreter w/o lightgbm;
#   (2) the ML deps (lightgbm/numpy/pandas/sklearn) live in the PER-USER site-packages
#       (...Roaming\Python\Python314\site-packages), which a 1 AM Scheduled Task does
#       NOT auto-add to sys.path (profile/%APPDATA% not loaded). Manual runs worked,
#       masking it for days. The task even reported exit 0 (false success).
# Defense-in-depth: (a) force the user-site dir onto PYTHONPATH; (b) try MULTIPLE
# Python 3.14 interpreters; (c) VERIFY all 4 deps import BEFORE the real run; (d) if
# none work, AUTO-INSTALL them (--user) and retry; (e) if that ALSO fails, hard-fail
# LOUD (non-zero exit -> watchdog Telegrams). The last-good models are always left
# intact, so a failed retrain never degrades live behavior.

$userSite = 'C:\Users\mrrai\AppData\Roaming\Python\Python314\site-packages'
if (Test-Path $userSite) {
    $env:PYTHONPATH = if ($env:PYTHONPATH) { "$userSite;$env:PYTHONPATH" } else { $userSite }
    Log ("PYTHONPATH -> user-site: " + $userSite)
}

# Candidate interpreters (all must be Python 3.14 to load the 3.14-built deps), priority order.
# TOP priority: the dedicated retrain venv. Its python carries the 4 ML deps in its OWN
# site-packages, ALWAYS on sys.path by construction — immune to the per-user-site visibility
# trap that broke 1 AM tasks for days (no %APPDATA%/profile dependency, no logon-type, no admin).
# This is the structural fix; the rest are fallbacks if the venv is ever deleted.
$candidates = @(
    (Join-Path $PSScriptRoot '..\.retrain_venv\Scripts\python.exe'),
    'C:\Python314\python.exe',
    'C:\Users\mrrai\AppData\Local\Python\pythoncore-3.14-64\python.exe'
)
$pc = Get-Command python -ErrorAction SilentlyContinue
if ($pc -and $pc.Source) { $candidates += $pc.Source }

$REQUIRED = "import importlib`n[importlib.import_module(m) for m in ['lightgbm','numpy','pandas','sklearn']]`nprint('DEPS_OK')"

function Test-PyDeps([string]$exe) {
    # Robust: (1) -W ignore so import-time Deprecation/Future/UserWarnings never hit stderr;
    # (2) stdout captured to a temp file, stderr discarded separately (NOT 2>&1 — on PS 5.1
    #     merging native stderr wraps each line in a NativeCommandError which, under
    #     ErrorActionPreference='Stop', THROWS and false-fails a perfectly good interpreter);
    # (3) EAP forced to Continue locally so nothing can throw; (4) verdict from stdout DEPS_OK
    #     + real process exit code only.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        & $exe -s -W ignore -c $REQUIRED 1>$tmp 2>$null
        $code = $LASTEXITCODE
        $out  = Get-Content $tmp -Raw -ErrorAction SilentlyContinue
        return (($code -eq 0) -and ($out -match 'DEPS_OK'))
    } catch { return $false }
    finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        $ErrorActionPreference = $prev
    }
}

$pythonExe = $null
foreach ($c in ($candidates | Select-Object -Unique)) {
    if (-not (Test-Path $c)) { continue }
    if (Test-PyDeps $c) { $pythonExe = $c; Log ("Interpreter OK (all 4 deps import): " + $c); break }
    Log ("  candidate missing deps, skipping: " + $c)
}

# Self-heal: no interpreter had the deps -> REBUILD the dedicated venv (permanent, self-
# contained). This is the durable repair: a fresh venv carries the deps in its own
# site-packages, so it can't regress to the user-site visibility trap. NO --upgrade
# (re-resolving numpy/pandas/sklearn can hang the 1 AM task); --no-input avoids prompts.
if (-not $pythonExe) {
    $venvDir = Join-Path $PSScriptRoot '..\.retrain_venv'
    $venvPy  = Join-Path $venvDir 'Scripts\python.exe'
    $bootstrap = @($candidates) | Where-Object { (Test-Path $_) -and ($_ -notlike '*\.retrain_venv\*') } | Select-Object -First 1
    if ($bootstrap) {
        Log ("!! No interpreter had the ML deps -- REBUILDING dedicated venv via " + $bootstrap)
        if (-not (Test-Path $venvPy)) { & $bootstrap -m venv $venvDir 2>&1 | ForEach-Object { Log ("   venv: " + $_) } }
        if (Test-Path $venvPy) {
            & $venvPy -m pip install --no-input --disable-pip-version-check lightgbm numpy pandas scikit-learn 2>&1 |
                ForEach-Object { Log ("   pip: " + $_) }
            if (Test-PyDeps $venvPy) { $pythonExe = $venvPy; Log ("Self-heal OK -- venv rebuilt, using " + $venvPy) }
        }
        # Last-ditch fallback: --user install on the bootstrap interpreter (old behavior).
        if (-not $pythonExe) {
            Log ("!! venv rebuild did not satisfy deps -- falling back to --user install via " + $bootstrap)
            & $bootstrap -m pip install --user --no-input --disable-pip-version-check lightgbm numpy pandas scikit-learn 2>&1 |
                ForEach-Object { Log ("   pip: " + $_) }
            if (Test-PyDeps $bootstrap) { $pythonExe = $bootstrap; Log ("Self-heal OK -- deps installed (--user), using " + $bootstrap) }
            else { Log ("!! Self-heal re-test still failed right after install (deps may finish async) — next run will pick them up") }
        }
    }
}

# Hard-fail LOUD if we still cannot import the deps (never silently no-op again).
if (-not $pythonExe) {
    Log ("!! RETRAIN ABORTED: no Python 3.14 interpreter can import lightgbm/numpy/pandas/sklearn")
    Log ("!! even after auto-install. Models NOT touched (last-good preserved). Watchdog will alert.")
    exit 3
}

# -- BACKUP last-good models BEFORE retraining (restore point if a retrain goes bad) --
# The trainer has per-bundle --auto-rollback, but a full timestamped snapshot also
# protects against systemic failures (trainer crash mid-write, bad floor config, disk
# error). Zipped (JSON compresses ~10x); keep the newest 10. Restore via restore_models.ps1.
try {
    $backupRoot = "$projectDir\models\_model_backups"
    if (-not (Test-Path $backupRoot)) { New-Item -ItemType Directory -Force $backupRoot | Out-Null }
    $stage = "$backupRoot\_stage_$ts"
    New-Item -ItemType Directory -Force $stage | Out-Null
    $bundles = Get-ChildItem "$projectDir\models" -Filter '*.json' |
        Where-Object { $_.Name -match '^(NQ|ES|CL|GC)_(RTH|ETH)_' }
    foreach ($b in $bundles) { Copy-Item $b.FullName $stage -Force }
    # also snapshot the owner-locked config jsons so a restore brings back the whole state
    foreach ($cfg in 'disabled_bundles.json','quality_floors.json','session_quality.json','exhaust_guard.json','dir_guard.json','chop_guard.json') {
        $p = "$projectDir\models\$cfg"; if (Test-Path $p) { Copy-Item $p $stage -Force }
    }
    if ($bundles.Count -gt 0) {
        $zip = "$backupRoot\models_backup_$ts.zip"
        Compress-Archive -Path "$stage\*" -DestinationPath $zip -Force
        Log ("Backed up " + $bundles.Count + " bundle models + configs -> " + (Split-Path $zip -Leaf))
    } else {
        Log ("  !! backup skipped: 0 bundle models found (nothing to snapshot)")
    }
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    # prune: keep newest 10 snapshots
    Get-ChildItem $backupRoot -Filter 'models_backup_*.zip' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -Skip 10 |
        Remove-Item -Force -ErrorAction SilentlyContinue
} catch { Log ("  !! backup step failed (non-fatal, retrain continues): " + $_.Exception.Message) }

$proc = Start-Process `
    -FilePath         $pythonExe `
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
if ($null -eq $rc) { $rc = 1 }   # null ExitCode = treat as FAILURE, never as silent success

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
# A Python traceback in stderr = hard failure even if the exit code lies (the trainer
# has historically reported exit 0 while crashing on import). Never report a false PASS.
$stderrHasError = $false
if (Test-Path $errLog) {
    $errTxt = Get-Content $errLog -Raw -ErrorAction SilentlyContinue
    if ($errTxt -and ($errTxt -match 'Traceback|ModuleNotFoundError|ImportError')) { $stderrHasError = $true }
}
$failed = ($rc -ne 0) -or $stderrHasError
if ($failed -and $rc -eq 0) { $rc = 1 }   # make the exit code agree with reality

Log ""
Log ("=== Results (elapsed: " + $elapsedMin + " min) ===")
$status = if (-not $failed) { 'PASS' } else { ("FAIL rc=" + $rc + $(if ($stderrHasError) { ' (python traceback)' } else { '' })) }
Log ("{0,-12} deployed={1,2}  rejected={2,2}  rolled_back={3,2}" `
    -f $status, $deployed, $rejected, $rolledBack)

# Surface stderr details
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
