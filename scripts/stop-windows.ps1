$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot "data\genesis.pid"

if (-not (Test-Path $PidFile)) {
  Write-Host "[Project Genesis] No PID file found at $PidFile."
  exit 0
}

$TargetPid = (Get-Content -Path $PidFile -Raw).Trim()
if ($TargetPid -match "^\d+$") {
  $proc = Get-Process -Id ([int]$TargetPid) -ErrorAction SilentlyContinue
  if ($null -ne $proc) {
    Stop-Process -Id $proc.Id -Force
    Write-Host "[Project Genesis] Stopped server process PID $TargetPid."
  } else {
    Write-Host "[Project Genesis] Process PID $TargetPid is no longer running."
  }
}

Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
