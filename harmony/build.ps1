param([string]$DevEco='D:/SWE-OpenHarmony/DevEcoStudio')
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:DEVECO_SDK_HOME=Join-Path $DevEco 'sdk'
$env:JAVA_HOME=Join-Path $DevEco 'jbr'
$env:Path="$env:JAVA_HOME/bin;$DevEco/tools/node;$env:Path"
$env:HVIGOR_USER_HOME=Join-Path $PSScriptRoot '.hvigor-home'
& "$DevEco/tools/node/node.exe" "$DevEco/tools/hvigor/bin/hvigorw.js" --mode module -p product=default -p module=entry@default -p buildMode=debug assembleHap --no-daemon
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$builtHap=Join-Path $PSScriptRoot 'entry/build/default/outputs/default/entry-default-unsigned.hap'
if (!(Test-Path -LiteralPath $builtHap)) { throw 'Build completed without the expected HAP.' }
$deliveryDir=Join-Path $PSScriptRoot '../dist'
New-Item -ItemType Directory -Path $deliveryDir -Force | Out-Null
Copy-Item -LiteralPath $builtHap -Destination (Join-Path $deliveryDir 'seatraces-0.1.0-unsigned.hap') -Force
Write-Host 'Updated dist/seatraces-0.1.0-unsigned.hap'
