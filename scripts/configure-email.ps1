param([ValidateSet('smtp','tencent_ses')][string]$Provider = 'smtp')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
$content = if (Test-Path -LiteralPath $envPath) { [IO.File]::ReadAllText($envPath) } else { '' }
Write-Host '配置验证邮箱与密码找回；不发送邮件，不重启服务。留空保留原值。'
Write-Host ('发信方式：' + $Provider)
$settings = @{}
$names = if ($Provider -eq 'tencent_ses') { @('APP_ORIGIN','SES_REGION','SES_FROM','SES_TEMPLATE_VERIFY_EMAIL','SES_TEMPLATE_RESET_PASSWORD','SES_TEMPLATE_PASSWORD_CHANGED','SES_SECRET_ID','SES_SECRET_KEY') } else { @('APP_ORIGIN','SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_FROM','SMTP_PASSWORD') }
$settings['MAIL_PROVIDER'] = $Provider
foreach ($name in $names) {
  if ($name -in @('SMTP_PASSWORD','SES_SECRET_ID','SES_SECRET_KEY')) {
    $secret = Read-Host ($name + '（隐藏输入）') -AsSecureString
    if ($secret.Length -eq 0) { $secret.Dispose(); continue }
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $secret.Dispose() }
  } else { $value = Read-Host $name }
  if ([string]::IsNullOrWhiteSpace($value)) { continue }
  if ($value.Contains("`r") -or $value.Contains("`n") -or $value.Contains("'") -or $value.Contains('"')) { throw '配置含不支持的字符，本次未保存' }
  if ($name -eq 'SMTP_PORT' -and $value -notin @('465','587')) { throw 'SMTP_PORT 请选择 465 或 587' }
  if ($name -eq 'SES_REGION' -and $value -notin @('ap-guangzhou','ap-hongkong')) { throw 'SES_REGION 请选择 ap-guangzhou 或 ap-hongkong' }
  if ($name.StartsWith('SES_TEMPLATE_') -and ($value -notmatch '^[1-9][0-9]*$' -or $value.Length -gt 15)) { throw '模板 ID 必须为有效正整数' }
  if ($name -eq 'SES_FROM' -and $value -notmatch '^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$') { throw 'SES_FROM 填完整发信邮箱，不要填别名' }
  if ($name -eq 'APP_ORIGIN') {
    $uri = [Uri]$value
    if (!$uri.IsAbsoluteUri -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment -or
        ($uri.Scheme -ne 'https' -and !($uri.Scheme -eq 'http' -and $uri.Host -in @('127.0.0.1','localhost')))) { throw 'APP_ORIGIN 必须为 HTTPS 站点根地址，本机可用 http://127.0.0.1:8788' }
  }
  $settings[$name] = $value
}
$keyMatch = [regex]::Match($content, '(?m)^MAIL_OUTBOX_KEY\s*=\s*([^\r\n]*)')
$existingKey = $keyMatch.Groups[1].Value.Trim().Trim([char]39,[char]34)
if ($existingKey) {
  try { $keyBytes = [Convert]::FromBase64String($existingKey) } catch { throw '现有 MAIL_OUTBOX_KEY 无效；未覆盖文件，请先核对备份' }
  if ($keyBytes.Length -ne 32) { throw '现有 MAIL_OUTBOX_KEY 长度无效；未覆盖文件，请先核对备份' }
  [Array]::Clear($keyBytes,0,$keyBytes.Length)
} else {
  $keyBytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($keyBytes); $settings['MAIL_OUTBOX_KEY'] = [Convert]::ToBase64String($keyBytes) }
  finally { $rng.Dispose(); [Array]::Clear($keyBytes,0,$keyBytes.Length) }
  Write-Host '已生成邮件队列密钥；后续运行会保留此密钥。'
}
foreach ($name in $settings.Keys) {
  $line = $name + "='" + $settings[$name] + "'"
  $pattern = '(?m)^' + [regex]::Escape($name) + '=.*$'
  if ([regex]::IsMatch($content,$pattern)) { $content = [regex]::Replace($content,$pattern,[System.Text.RegularExpressions.MatchEvaluator]{ param($match) $line }) }
  else { $content += "`n" + $line + "`n" }
}
[IO.File]::WriteAllText($envPath,$content,[Text.UTF8Encoding]::new($false))
$settings.Clear(); $content = $null; $value = $null; $line = $null
Write-Host '配置已保存到本机 .env。请运行 node scripts/check-mail.mjs --verify；配置通过后再重启后端测试收信。不要将 .env 加入交付包。'
