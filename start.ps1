param([switch]$Foreground)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
if (!(Test-Path -LiteralPath 'node_modules')) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' } }
& './scripts/start-frontend.ps1'
if (Test-Path -LiteralPath '.runtime/catalog-access/approved.json') { & './scripts/connect-catalog.ps1' }
try { $health=Invoke-RestMethod 'http://127.0.0.1:8787/api/health' -TimeoutSec 2; if ($health.ok) { Write-Host 'SeaTraces API is running. Open frontend: http://127.0.0.1:8788'; return } } catch {}
if ($Foreground) { & node scripts/local.mjs; exit $LASTEXITCODE }
New-Item -ItemType Directory -Path '.runtime' -Force | Out-Null
$nodeCommand=(Get-Command node).Source
$process=Start-Process -FilePath $nodeCommand -ArgumentList 'scripts/local.mjs' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput "$PSScriptRoot/.runtime/server.log" -RedirectStandardError "$PSScriptRoot/.runtime/server-error.log" -PassThru
$process.Id | Set-Content -LiteralPath '.runtime/server.pid'
Write-Host 'Open SeaTraces at http://127.0.0.1:8788 . API backend starts on 8787.'
