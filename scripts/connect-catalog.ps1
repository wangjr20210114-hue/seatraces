param([switch]$Stop)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$accessRoot=Join-Path $projectRoot '.runtime/catalog-access'
$configuration=Join-Path $accessRoot 'approved.json'
$connectionState=Join-Path $accessRoot 'connection.json'
$scriptPath=Join-Path $PSScriptRoot 'catalog-connection.mjs'
if (Test-Path -LiteralPath $connectionState) {
  $state=Get-Content -LiteralPath $connectionState | ConvertFrom-Json
  $worker=Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$state.pid)"
  if ($worker -and ($worker.Name -ne 'node.exe' -or $worker.CommandLine -notlike '*catalog-connection.mjs*')) { throw 'Connection PID belongs to a different process; refusing to change it' }
  if ($worker -and !$Stop) { Write-Host 'Catalog connection worker already running. Check /api/catalog/coverage for live status.'; return }
  if ($state.sshPid) {
    $sshProcess=Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$state.sshPid)"
    if ($sshProcess) {
      if ($sshProcess.Name -ne 'ssh.exe' -or $sshProcess.CommandLine -notlike '*catalog-access*' -or $sshProcess.CommandLine -notlike '*ubuntu@124.223.110.193*') { throw 'SSH process identity mismatch' }
      # Stop the supervisor first to prevent an automatic reconnect.
      if ($worker) { Stop-Process -Id $worker.ProcessId; $worker=$null }
      Stop-Process -Id $sshProcess.ProcessId
    }
  }
  if ($worker) { Stop-Process -Id $worker.ProcessId }
}
if ($Stop) { Write-Host 'Local catalog connection stopped. Server authorization remains until explicitly revoked.'; return }
if (!(Test-Path -LiteralPath $configuration)) { throw 'Catalog connection has not been authorized and configured.' }
$config=Get-Content -LiteralPath $configuration | ConvertFrom-Json
if ($config.scope -ne 'catalog-loopback-only' -or !$config.approvedAt) { throw 'Catalog authorization metadata is missing' }
$node=(Get-Command node).Source
$process=Start-Process -FilePath $node -ArgumentList ('"'+$scriptPath+'"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $accessRoot 'connection.log') -RedirectStandardError (Join-Path $accessRoot 'connection-error.log') -PassThru
Write-Host "Catalog connection worker started, PID $($process.Id). Database and shell access are not exposed."
