# 配置本地前端连接的业务服务地址。

param([ValidateSet('all','amap','deepseek')][string]$Provider='all')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$envPath=Join-Path $projectRoot '.env'
$content=if(Test-Path -LiteralPath $envPath){[IO.File]::ReadAllText($envPath)}else{"API_MONTHLY_BUDGET_CNY=200`nAPI_DAILY_REQUEST_LIMIT=400`nAMAP_DAILY_REQUEST_LIMIT=300`nDEEPSEEK_DAILY_REQUEST_LIMIT=50`nGOOGLE_DAILY_REQUEST_LIMIT=30`nOSM_SERVICE_URL=http://127.0.0.1:8791`n"}
$keyNames=switch($Provider){'amap'{@('AMAP_KEY')};'deepseek'{@('DEEPSEEK_API_KEY')};default{@('AMAP_KEY','DEEPSEEK_API_KEY')}}
Write-Host '只在此窗口输入密钥；输入隐藏，回车保留原值。所有输入校验通过后一次保存。'
foreach($keyName in $keyNames){
  $secret=Read-Host $keyName -AsSecureString
  if($secret.Length -eq 0){continue}
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  try{$value=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$secret.Dispose()}
  if($value -notmatch '^[A-Za-z0-9_-]{8,256}$'){throw "$keyName 格式无效，本次未写入配置"}
  $pattern='(?m)^'+[regex]::Escape($keyName)+'=.*$'
  if([regex]::IsMatch($content,$pattern)){$content=[regex]::Replace($content,$pattern,($keyName+'='+$value))}else{$content+="`n$keyName=$value`n"}
  $value=$null
}
if($content -notmatch '(?m)^DEEPSEEK_MODEL='){$content+="`nDEEPSEEK_MODEL=deepseek-flash`n"}
if($content -notmatch '(?m)^AMAP_POI_VERSION='){$content+="`nAMAP_POI_VERSION=v5`n"}
[IO.File]::WriteAllText($envPath,$content,[Text.UTF8Encoding]::new($false))
$content=$null
Write-Host '配置已保存到本机 .env。没有发送接口请求，没有自动充值或重启服务。'
Write-Host '运行 npm run providers:status 检查配置状态；真实连接检查按接入说明执行。'
