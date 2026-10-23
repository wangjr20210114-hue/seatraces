# 向模拟器安装应用并启动主界面。

param(
    [string]$DevEco = 'D:/SWE-OpenHarmony/DevEcoStudio',
    [Parameter(Mandatory=$true)][string]$DeviceId
)
$ErrorActionPreference = 'Stop'
$hdc = Join-Path $DevEco 'sdk/default/openharmony/toolchains/hdc.exe'
$hap = Join-Path $PSScriptRoot '../dist/seatraces-0.1.0-unsigned.hap'
if (!(Test-Path -LiteralPath $hdc)) { throw "HDC not found. Set -DevEco to your DevEco Studio installation." }
if (!(Test-Path -LiteralPath $hap)) { throw "Build the HAP with harmony/build.ps1 first." }
$targets = @(& $hdc list targets | ForEach-Object { $_.Trim() })
if ($LASTEXITCODE -ne 0 -or $targets -notcontains $DeviceId) { throw "The requested device is not connected. Start it in DevEco Device Manager first." }
$health = Invoke-RestMethod 'http://127.0.0.1:8788/frontend-health' -TimeoutSec 5
if ($health.service -ne 'seatraces-frontend') { throw "Start the frontend first with start.ps1 or scripts/start-frontend.ps1." }
$mappingOutput = @(& $hdc -t $DeviceId fport ls 2>&1)
$mappingPattern = '^' + [regex]::Escape($DeviceId) + '\s+tcp:8788\s+tcp:8788\s+\[Reverse\]\s*$'
$hasMapping = @($mappingOutput | Where-Object { "$_" -match $mappingPattern }).Count -gt 0
if (!$hasMapping) {
    $forwardOutput = @(& $hdc -t $DeviceId rport tcp:8788 tcp:8788 2>&1)
    $forwardExit = $LASTEXITCODE
    $forwardOutput | ForEach-Object { Write-Host $_ }
    if ($forwardExit -ne 0 -or ($forwardOutput -join "`n") -notmatch 'Forwardport result:OK') {
        throw "Port mapping was not confirmed. Check the device port without removing unrelated mappings."
    }
} else {
    Write-Host 'Reusing the existing device-to-host 8788 mapping.'
}
$installOutput = @(& $hdc -t $DeviceId install $hap 2>&1)
$installExit = $LASTEXITCODE
$installOutput | ForEach-Object { Write-Host $_ }
if ($installExit -ne 0 -or ($installOutput -join "`n") -notmatch 'install bundle successfully') {
    throw "HAP installation was not confirmed. Your target may require a signed package."
}
$launchOutput = @(& $hdc -t $DeviceId shell aa start -a EntryAbility -b com.seatraces.travel 2>&1)
$launchExit = $LASTEXITCODE
$launchText = $launchOutput -join "`n"
$launchOutput | ForEach-Object { Write-Host $_ }
if ($launchExit -ne 0 -or $launchText -notmatch 'start ability successfully\.') {
    throw "Ability launch was not confirmed. If the emulator screen is locked, unlock it and rerun this script."
}
Write-Host 'SeaTraces started. Confirm that the page is visible in the emulator.'
