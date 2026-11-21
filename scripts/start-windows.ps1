param(
  [switch]$AllowLan,
  [switch]$Production,
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js 20+ is required on PATH."
  exit 1
}

if (-not (Test-Path ".env") -and (Test-Path ".env.example")) {
  Copy-Item ".env.example" ".env"
  Write-Host "[Project Genesis] Created .env from .env.example"
}

if (-not (Test-Path "node_modules")) {
  Write-Host "[Project Genesis] Installing Node dependencies..."
  npm install
}

$BindHost = if ($AllowLan) { "0.0.0.0" } else { "127.0.0.1" }
$env:HOST = $BindHost
$env:PORT = "$Port"

if ($AllowLan) {
  Write-Warning "LAN exposure enabled (HOST=0.0.0.0). Enable local operator passcode lock in System Settings before accepting LAN traffic."
} else {
  Write-Host "[Project Genesis] Starting in secure localhost-only mode (http://127.0.0.1:$Port)"
}

if ($Production) {
  Write-Host "[Project Genesis] Building production bundle..."
  npm run build
  $env:NODE_ENV = "production"
  $proc = Start-Process -FilePath "npm" -ArgumentList "run", "start" -PassThru -NoNewWindow
} else {
  $proc = Start-Process -FilePath "npm" -ArgumentList "run", "dev" -PassThru -NoNewWindow
}

$PidFile = Join-Path $ProjectRoot "data\genesis.pid"
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "data") | Out-Null
Set-Content -Path $PidFile -Value "$($proc.Id)"
Write-Host "[Project Genesis] Running (PID $($proc.Id)). Stop with .\scripts\stop-windows.ps1"
Wait-Process -Id $proc.Id
