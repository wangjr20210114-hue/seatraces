$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
$content = if (Test-Path -LiteralPath $envPath) { [IO.File]::ReadAllText($envPath) } else { '' }
Write-Host '配置验证邮箱与密码找回；不发送邮件，不重启服务。留空保留原值。'
$settings = @{}
foreach ($name in @('APP_ORIGIN','SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_FROM','SMTP_PASSWORD')) {
  if ($name -eq 'SMTP_PASSWORD') {
    $secret = Read-Host 'SMTP_PASSWORD（授权码，隐藏输入）' -AsSecureString
    if ($secret.Length -eq 0) { $secret.Dispose(); continue }
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $secret.Dispose() }
  } else { $value = Read-Host $name }
  if ([string]::IsNullOrWhiteSpace($value)) { continue }
  if ($value.Contains("`r") -or $value.Contains("`n") -or $value.Contains("'") -or $value.Contains('"')) { throw '配置含不支持的字符，本次未保存' }
  if ($name -eq 'SMTP_PORT' -and $value -notin @('465','587')) { throw 'SMTP_PORT 请选择 465 或 587' }
  if ($name -eq 'APP_ORIGIN') {
    $uri = [Uri]$value
    if (!$uri.IsAbsoluteUri -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment -or
        ($uri.Scheme -ne 'https' -and !($uri.Scheme -eq 'http' -and $uri.Host -in @('127.0.0.1','localhost')))) { throw 'APP_ORIGIN 必须为 HTTPS 站点根地址，本机可用 http://127.0.0.1:8788' }
  }
  $settings[$name] = $value
}
foreach ($name in $settings.Keys) {
  $line = $name + "='" + $settings[$name] + "'"
  $pattern = '(?m)^' + [regex]::Escape($name) + '=.*$'
  if ([regex]::IsMatch($content,$pattern)) { $content = [regex]::Replace($content,$pattern,[System.Text.RegularExpressions.MatchEvaluator]{ param($match) $line }) }
  else { $content += "`n" + $line + "`n" }
}
[IO.File]::WriteAllText($envPath,$content,[Text.UTF8Encoding]::new($false))
$settings.Clear(); $content = $null; $value = $null; $line = $null
Write-Host '配置已保存到本机 .env；重启后可在“我的账号”绑定邮箱。不要将 .env 加入交付包。'
