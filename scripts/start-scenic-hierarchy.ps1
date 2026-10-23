# 启动景区层级批处理任务。

param([switch]$OfflineOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $projectRoot '.runtime/scenic-hierarchy'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
if (-not $env:OSM_PYTHON) {
    $configPath = Join-Path $projectRoot '.runtime/osm-venv/pyvenv.cfg'
    if (Test-Path -LiteralPath $configPath) {
        $pythonLine = Get-Content -LiteralPath $configPath | Where-Object { $_ -match '^executable = ' } | Select-Object -First 1
        if ($pythonLine) {
            $candidate = $pythonLine.Substring('executable = '.Length).Trim()
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $env:OSM_PYTHON = $candidate }
        }
    }
    if (-not $env:OSM_PYTHON) { $env:OSM_PYTHON = (Get-Command python).Source }
}
$nodeExecutable = (Get-Command node).Source
$arguments = @('scripts/run-scenic-hierarchy.mjs','--run')
if (-not $OfflineOnly) { $arguments += '--llm' }
$process = Start-Process -FilePath $nodeExecutable -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'worker.log') -RedirectStandardError (Join-Path $runtimePath 'worker-error.log') -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $runtimePath 'worker.pid')
Write-Host "Hierarchy batch started (PID $($process.Id)). It checkpoints automatically and exits after one complete pass."
Write-Host 'Read status: node scripts/run-scenic-hierarchy.mjs --status'
Write-Host 'Stop safely: node scripts/run-scenic-hierarchy.mjs --stop'
