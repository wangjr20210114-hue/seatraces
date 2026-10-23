# 启动前端资源服务和接口转发。

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
try {
    $health = Invoke-RestMethod 'http://127.0.0.1:8788/frontend-health' -TimeoutSec 2
    if ($health.service -eq 'seatraces-frontend') { Write-Host 'Frontend already running: http://127.0.0.1:8788'; return }
    throw 'Port 8788 belongs to another service'
} catch {
    if ($_.Exception.Message -eq 'Port 8788 belongs to another service') { throw }
}
New-Item -ItemType Directory -Path (Join-Path $projectRoot '.runtime') -Force | Out-Null
$node = (Get-Command node).Source
$process = Start-Process -FilePath $node -ArgumentList 'server/frontend.mjs' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot '.runtime/frontend.log') -RedirectStandardError (Join-Path $projectRoot '.runtime/frontend-error.log') -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $projectRoot '.runtime/frontend.pid')
Write-Host 'Frontend starting: http://127.0.0.1:8788 (API backend: 8787)'
