#Requires -Version 5.1
# ============================================================================
# Antigravity v2 -- Model Restore (roll bundle models back to a backup snapshot)
#
# retrain_parallel.ps1 zips the last-good bundle models + locked configs to
#   models\_model_backups\models_backup_<timestamp>.zip   (newest 10 kept)
# BEFORE every retrain. This script restores one of those snapshots if a retrain
# (or anything else) corrupted / degraded the live models.
#
# Usage:
#   .\restore_models.ps1                 # list available snapshots, newest first
#   .\restore_models.ps1 -Latest         # restore the newest snapshot
#   .\restore_models.ps1 -Snapshot models_backup_20260605_0100   # restore a named one
#   .\restore_models.ps1 -Latest -DryRun # show what WOULD be restored, change nothing
#
# Safe-by-default: before overwriting, it snapshots the CURRENT models to a
# pre-restore zip, so a restore is itself reversible.
# ============================================================================
param(
    [string]$Snapshot,
    [switch]$Latest,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$projectDir = 'D:\Google AntiGravity'
$modelsDir  = "$projectDir\models"
$backupRoot = "$modelsDir\_model_backups"
$ts         = Get-Date -Format 'yyyyMMdd_HHmm'

if (-not (Test-Path $backupRoot)) {
    Write-Host "No backups yet ($backupRoot does not exist). A backup is created automatically before each retrain."
    exit 1
}

$zips = Get-ChildItem $backupRoot -Filter 'models_backup_*.zip' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending

if (-not $zips -or $zips.Count -eq 0) {
    Write-Host "No snapshot zips found in $backupRoot."
    exit 1
}

# -- No target specified: list and exit --------------------------------------
if (-not $Latest -and -not $Snapshot) {
    Write-Host "Available model snapshots (newest first):`n"
    $i = 0
    foreach ($z in $zips) {
        $i++
        $sizeMB = [math]::Round($z.Length / 1MB, 1)
        Write-Host ("  [{0,2}] {1}   {2} MB   {3}" -f $i, $z.BaseName, $sizeMB, $z.LastWriteTime)
    }
    Write-Host "`nRestore with:  .\restore_models.ps1 -Latest        (newest)"
    Write-Host   "          or:  .\restore_models.ps1 -Snapshot $($zips[0].BaseName)"
    exit 0
}

# -- Resolve the target zip --------------------------------------------------
$target = if ($Latest) { $zips[0] } else {
    $name = if ($Snapshot -match '\.zip$') { $Snapshot } else { "$Snapshot.zip" }
    $hit  = $zips | Where-Object { $_.Name -eq $name }
    if (-not $hit) { Write-Host "Snapshot not found: $name`nRun with no args to list snapshots."; exit 1 }
    $hit
}

Write-Host "Restore target : $($target.Name)   ($($target.LastWriteTime))"
$tmp = "$env:TEMP\ag_restore_$ts"
New-Item -ItemType Directory -Force $tmp | Out-Null
Expand-Archive -Path $target.FullName -DestinationPath $tmp -Force
$files = Get-ChildItem $tmp -Filter '*.json'
Write-Host "Contains       : $($files.Count) json files (bundles + locked configs)"

if ($DryRun) {
    Write-Host "`nDRY RUN -- would overwrite the above files in $modelsDir. Nothing changed."
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}

# -- Safety: snapshot CURRENT models first so the restore is reversible -------
$preZip = "$backupRoot\pre_restore_$ts.zip"
$preStage = "$backupRoot\_prestage_$ts"
New-Item -ItemType Directory -Force $preStage | Out-Null
Get-ChildItem $modelsDir -Filter '*.json' |
    Where-Object { $_.Name -match '^(NQ|ES|CL|GC)_(RTH|ETH)_' -or
                   $_.Name -in @('disabled_bundles.json','quality_floors.json','session_quality.json','exhaust_guard.json','dir_guard.json','chop_guard.json') } |
    ForEach-Object { Copy-Item $_.FullName $preStage -Force }
if ((Get-ChildItem $preStage).Count -gt 0) {
    Compress-Archive -Path "$preStage\*" -DestinationPath $preZip -Force
    Write-Host "Pre-restore safety snapshot: $(Split-Path $preZip -Leaf)"
}
Remove-Item $preStage -Recurse -Force -ErrorAction SilentlyContinue

# -- Apply the restore -------------------------------------------------------
$restored = 0
foreach ($f in $files) { Copy-Item $f.FullName "$modelsDir\$($f.Name)" -Force; $restored++ }
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "`nRESTORED $restored model files from $($target.BaseName)."
Write-Host "Restart the server so it reloads the restored models:"
Write-Host "  & '$projectDir\scripts\restart_server.ps1'"
