$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $projectRoot '.runtime/deepseek-hierarchy'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$nodeExecutable = (Get-Command node).Source
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$process = Start-Process -FilePath $nodeExecutable -ArgumentList @('scripts/assess-five-city-deepseek.mjs','--run') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath "worker-$stamp.log") -RedirectStandardError (Join-Path $runtimePath "worker-$stamp-error.log") -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $runtimePath 'worker.pid')
Write-Host "DeepSeek assessment started (PID $($process.Id)). Checkpoints allow safe resume; it exits after one pass."
Write-Host 'Read status: node scripts/assess-five-city-deepseek.mjs --status'
Write-Host 'Stop safely: node scripts/assess-five-city-deepseek.mjs --stop'
