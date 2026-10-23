# 配置地图服务所需的环境参数。

param([ValidateSet('amap','google')][string]$Provider='amap')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$envPath=Join-Path $projectRoot '.env'
$content=if(Test-Path -LiteralPath $envPath){[IO.File]::ReadAllText($envPath)}else{"API_MONTHLY_BUDGET_CNY=200`nOSM_SERVICE_URL=http://127.0.0.1:8791`n"}
Write-Host "在本机输入 $Provider 凭据；留空保留现有值。输入不会显示在屏幕或写入日志。"
$keyNames=if($Provider -eq 'google'){@('GOOGLE_MAPS_SERVER_KEY','GOOGLE_MAPS_JS_KEY')}else{@('AMAP_KEY','AMAP_JS_KEY','AMAP_JS_SECURITY_CODE')}
foreach($keyName in $keyNames){
  $secret=Read-Host "$keyName" -AsSecureString
  if($secret.Length -eq 0){continue}
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  try{$value=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
  if($value -notmatch '^[A-Za-z0-9_-]{8,256}$'){throw "$keyName 格式不正确，未保存本次配置"}
  $pattern='(?m)^'+[regex]::Escape($keyName)+'=.*$'
  if([regex]::IsMatch($content,$pattern)){$content=[regex]::Replace($content,$pattern,($keyName+'='+$value))}else{$content+="`n$keyName=$value`n"}
  $value=$null
}
if($Provider -eq 'google'){
  $pattern='(?m)^OVERSEAS_MAP_PROVIDER=.*$'
  if([regex]::IsMatch($content,$pattern)){$content=[regex]::Replace($content,$pattern,'OVERSEAS_MAP_PROVIDER=google')}else{$content+="`nOVERSEAS_MAP_PROVIDER=google`n"}
}
[IO.File]::WriteAllText($envPath,$content,[Text.UTF8Encoding]::new($false))
Write-Host '凭据已保存在项目 .env（Git 与交付压缩包均排除此文件）。重启原型后生效。'
