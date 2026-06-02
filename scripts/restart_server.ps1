# Antigravity v2 — restart the brain server (kill existing Antigravity node, start fresh).
# Used by server_watchdog.js and runnable by hand. Does NOT touch the tradingview-mcp node.
$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\Google AntiGravity'

# Kill any existing Antigravity server.js (exclude the tradingview MCP node process)
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -like '*server.js*' -and $_.CommandLine -notlike '*tradingview*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Sleep -Seconds 2

$ts  = Get-Date -Format 'yyyyMMdd_HHmm'
$log = Join-Path $root ("logs\server_wd_" + $ts + ".log")
Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentList 'server.js' -WorkingDirectory $root `
  -RedirectStandardOutput $log -RedirectStandardError ($log + '.err') `
  -WindowStyle Hidden
Write-Output ("restart_server.ps1: started fresh server, log=" + $log)
