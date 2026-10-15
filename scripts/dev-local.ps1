param([string]$DevEco='D:/SWE-OpenHarmony/DevEcoStudio',[string]$DeviceId='', [switch]$Build, [switch]$Install, [switch]$NoDevice, [switch]$Restart)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$runtime=Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$node=(Get-Command node -ErrorAction Stop).Source
if ([int]((& $node --version).TrimStart('v').Split('.')[0]) -lt 24) { throw 'Node.js 24 or later is required.' }
if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules/express/package.json'))) {
    & npm.cmd ci
    if ($LASTEXITCODE) { throw 'npm ci failed' }
}
function Stop-RecordedService([string]$Name,[int]$Port) {
    $pidFile=Join-Path $runtime ($Name+'.pid')
    if (!(Test-Path -LiteralPath $pidFile)) { throw "Port $Port is already occupied without this project's process record. Stop that service first." }
    $servicePid=[int](Get-Content -LiteralPath $pidFile)
    $process=Get-CimInstance Win32_Process -Filter "ProcessId = $servicePid"
    if (!$process) { throw "Stale $Name process record; port $Port belongs to another process." }
    $absoluteScript=if($Name -eq 'server'){Join-Path $projectRoot 'scripts/local.mjs'}else{Join-Path $projectRoot 'server/frontend.mjs'}
    $relativeScript=if($Name -eq 'server'){'scripts/local.mjs'}else{'server/frontend.mjs'}
    $listener=@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    $knownAbsolute=$process.CommandLine.Contains($absoluteScript)
    $knownLegacy=($process.CommandLine -match ('(?:^|[\s"])(?:'+[regex]::Escape($relativeScript)+')(?:[\s"]|$)')) -and ($listener.OwningProcess -contains $servicePid)
    if ($process.Name -ne 'node.exe' -or !($knownAbsolute -or $knownLegacy)) { throw "Cannot verify ownership of $Name; left running." }
    # Stop only descendants of the verified watcher, then its root process.
    $all=@(Get-CimInstance Win32_Process)
    $ids=[System.Collections.Generic.List[int]]::new(); $ids.Add($servicePid)
    for($i=0;$i -lt $ids.Count;$i++){foreach($child in $all | Where-Object { $_.ParentProcessId -eq $ids[$i] -and $_.Name -eq 'node.exe' }){$ids.Add([int]$child.ProcessId)}}
    for($i=$ids.Count-1;$i -ge 0;$i--){Stop-Process -Id $ids[$i] -ErrorAction SilentlyContinue}
}
function Start-LocalService([string]$Name,[int]$Port,[string]$Script,[string]$Health) {
    $running=$false
    try { $reply=Invoke-RestMethod $Health -TimeoutSec 2; $running=($reply.ok -eq $true) } catch {}
    if ($running -and !$Restart) {
        $pidFile=Join-Path $runtime ($Name+'.pid')
        $recorded=if(Test-Path -LiteralPath $pidFile){Get-CimInstance Win32_Process -Filter "ProcessId = $([int](Get-Content -LiteralPath $pidFile))"}else{$null}
        if ($recorded -and $recorded.CommandLine.Contains((Join-Path $projectRoot $Script)) -and $recorded.CommandLine.Contains('--watch')) {
            Write-Host "Reusing local $Name on $Port (watch mode)."; return
        }
    }
    if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count) { Stop-RecordedService $Name $Port }
    $absolute=Join-Path $projectRoot $Script
    $child=Start-Process -FilePath $node -ArgumentList @('--watch',('"'+$absolute+'"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime ($Name+'.log')) -RedirectStandardError (Join-Path $runtime ($Name+'-error.log')) -PassThru
    $child.Id | Set-Content -LiteralPath (Join-Path $runtime ($Name+'.pid'))
    for($i=0;$i -lt 45;$i++){
        try { $healthResult=Invoke-RestMethod $Health -TimeoutSec 2; if($healthResult.ok){Write-Host "Local $Name ready on $Port (watch mode).";return} } catch {}
        if($child.HasExited){throw "$Name stopped. See .runtime/$Name-error.log"}
        Start-Sleep -Seconds 1
    }
    throw "$Name did not become ready. See .runtime/$Name-error.log"
}
# Explicit local settings take precedence over any production .env settings.
$env:NODE_ENV='development';$env:HOST='127.0.0.1';$env:PORT='8787'
$env:APP_ORIGIN='http://127.0.0.1:8788';$env:SKIP_MIGRATIONS='false';$env:REQUIRE_POSTGIS='false'
$env:FRONTEND_HOST='127.0.0.1';$env:FRONTEND_PORT='8788';$env:FRONTEND_API_ORIGIN='http://127.0.0.1:8787';$env:FRONTEND_TRUST_PROXY=''
if(Test-Path -LiteralPath (Join-Path $runtime 'catalog-access/approved.json')){& (Join-Path $PSScriptRoot 'connect-catalog.ps1')}
Start-LocalService 'server' 8787 'scripts/local.mjs' 'http://127.0.0.1:8787/api/health'
Start-LocalService 'frontend' 8788 'server/frontend.mjs' 'http://127.0.0.1:8788/frontend-health'
if($Build){& (Join-Path $projectRoot 'harmony/build.ps1') -DevEco $DevEco; if($LASTEXITCODE){throw 'HarmonyOS build failed'};Set-Location -LiteralPath $projectRoot}
if(!$NoDevice){
    $hdc=Join-Path $DevEco 'sdk/default/openharmony/toolchains/hdc.exe'
    if(!(Test-Path -LiteralPath $hdc)){throw 'HDC unavailable. Set -DevEco or use -NoDevice.'}
    $targets=@(& $hdc list targets | ForEach-Object {$_.Trim()} | Where-Object {$_ -and $_ -notmatch '^\[Empty\]|^\[Fail\]'})
    if(!$DeviceId -and $targets.Count -eq 1){$DeviceId=$targets[0]}
    if(!$DeviceId){Write-Host 'Local services are ready. Start the emulator in DevEco, then rerun this CMD. With multiple devices, pass -DeviceId.';return}
    if($targets -notcontains $DeviceId){throw 'Selected device is not connected.'}
    if($Install){& (Join-Path $projectRoot 'harmony/install-emulator.ps1') -DevEco $DevEco -DeviceId $DeviceId;if($LASTEXITCODE){throw 'Installation failed'}}
    else{
        $mapping=@(& $hdc -t $DeviceId fport ls 2>&1) -join "`n"
        if($mapping -notmatch ([regex]::Escape($DeviceId)+'\s+tcp:8788\s+tcp:8788\s+\[Reverse\]')){
            $result=@(& $hdc -t $DeviceId rport tcp:8788 tcp:8788 2>&1) -join "`n"
            if($LASTEXITCODE -ne 0 -or $result -notmatch 'Forwardport result:OK'){throw 'Device 8788 mapping failed.'}
        }
        $result=@(& $hdc -t $DeviceId shell aa start -a EntryAbility -b com.seatraces.travel 2>&1) -join "`n"
        if($LASTEXITCODE -ne 0 -or $result -notmatch 'start ability successfully'){Write-Host 'Install the client first: dev-local.cmd -Build -Install'}
    }
    Write-Host 'In the app: Connection settings -> Local development. The choice is remembered.'
}
Write-Host 'Local UI: http://127.0.0.1:8788 ; API: 127.0.0.1:8787. Refresh the app after saving; backend changes restart automatically.'

