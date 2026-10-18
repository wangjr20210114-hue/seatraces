# 腾讯云邮件接入

状态（2026-10-19）：SES 服务、域名与发信地址已完成配置。邮箱验证 `64137`、密码重置 `64138`、密码变更通知 `64139` 均已通过审核，本机只读核验通过。生产需要部署代码并单独加载邮件配置；真实收信由用户登录自己的账号、绑定邮箱验收。

## 1. 控制台开通

进入 [腾讯云邮件推送](https://console.cloud.tencent.com/ses)，选择广州或香港地域并开通。地域在后续配置中必须一致。

自 2026-03-02 起新开通的个人认证账号不支持 SMTP，可以使用 SES API。本项目已提供 API 方式，个人账号无需为 SMTP 办理企业认证。旧有可用的 SMTP 配置继续支持。参见 [官方公告](https://cloud.tencent.com/announce/detail/2212)。

## 2. 发信域名与地址

1. 邮件配置 → 发信域名 → 新建，填 `notify.seatraces.com`。
2. 点击验证，在 DNSPod 的 `seatraces.com` 解析记录中逐条添加控制台给出的记录。类型、主机记录、优先级和值必须逐项核对，不照抄其他域名的 DKIM/MX。保持 `trip` 的 A 记录不变，不覆盖现有根域名邮箱记录。
3. 回 SES 提交验证，等待验证通过。DNS 同步可能需要时间。
4. 邮件配置 → 发信地址 → 新建：前缀 `noreply`，域名 `notify.seatraces.com`，别名 `SeaTraces 海迹`。
5. 配置中的 `SES_FROM` 只填 `noreply@notify.seatraces.com`，不带别名。

参见 [邮件配置](https://cloud.tencent.com/document/product/1288/47454)。

## 3. 三份邮件模板

邮件配置 → 发信模板 → 新建，选择纯文本，分别上传下列文件，提交审核。链接固定为正式站点 `trip.seatraces.com`，务必保留 `{{token}}` 占位符，不要把完整网址或邮件正文作为变量。已有被驳回的模板应编辑原模板、重新上传并提交审核；保留模板 ID。

| 模板名称建议 | 上传文件（项目内） | 审核通过后对应配置 |
| --- | --- | --- |
| SeaTraces 邮箱验证 | `config/mail-templates/verify-email.txt` | `SES_TEMPLATE_VERIFY_EMAIL` |
| SeaTraces 密码重置 | `config/mail-templates/reset-password.txt` | `SES_TEMPLATE_RESET_PASSWORD` |
| SeaTraces 密码变更通知 | `config/mail-templates/password-changed.txt` | `SES_TEMPLATE_PASSWORD_CHANGED` |

前两份模板只使用 `token` 变量，固定地址分别为 `https://trip.seatraces.com/login.html#action=verify_email&token={{token}}` 和 `https://trip.seatraces.com/login.html#action=reset_password&token={{token}}`。后端只传 64 位十六进制一次性令牌，不传网址，令牌保存在 URL fragment 中。密码修改通知没有变量。只读核验还会检查固定域名、页面路径、用途与配置一致。模板 ID 是审核页面显示的正整数，不是模板名称。三份模板均需要审核通过。参见 [模板接口](https://cloud.tencent.com/document/product/1288/51042)。

## 4. 专用 API 凭据（由账号持有人完成）

在访问管理 CAM 为应用创建专用的编程访问用户，按以下自定义策略授权，不授予云服务器、数据库、财务或全管理权限。由账号持有人创建并保存其 API 密钥，不把 SecretKey 发到聊天或 Git。运行时与只读校验只需要下面三项操作：

```json
{
  "version": "2.0",
  "statement": [{
    "effect": "allow",
    "action": ["ses:SendEmail", "ses:GetEmailIdentity", "ses:GetEmailTemplate"],
    "resource": ["*"]
  }]
}
```

生产只在服务器发送时，可进一步按腾讯云支持的请求来源 IP 条件限制凭据；本机验证使用的出口不同，应事先确认。创建凭据、授予权限和任何费用确认由账号持有人处理。API 文档：[SendEmail](https://cloud.tencent.com/document/product/1288/51034)、[GetEmailIdentity](https://cloud.tencent.com/document/product/1288/51046)、[GetEmailTemplate](https://cloud.tencent.com/document/product/1288/51040)。

## 5. 本机填写

双击项目根目录 `configure-tencent-email.cmd`。它调用 PowerShell 交互输入，SecretId/SecretKey 使用隐藏输入，仅保存到被 Git 忽略的本机 `.env`。空白保留原值；不发送邮件、不重启服务。已有队列密钥保留，没有时生成 32 字节随机密钥。请按提示填：

```dotenv
MAIL_PROVIDER=tencent_ses
APP_ORIGIN=https://trip.seatraces.com
SES_REGION=ap-guangzhou
SES_FROM=noreply@notify.seatraces.com
SES_TEMPLATE_VERIFY_EMAIL=邮箱验证模板ID
SES_TEMPLATE_RESET_PASSWORD=密码重置模板ID
SES_TEMPLATE_PASSWORD_CHANGED=变更通知模板ID
SES_SECRET_ID=专用用户的SecretId
SES_SECRET_KEY=专用用户的SecretKey
MAIL_OUTBOX_KEY=由配置脚本生成或保留
```

广州 `ap-guangzhou`，香港 `ap-hongkong`。这些 SES 模板的域名固定为正式站点，因此本机使用它们时 `APP_ORIGIN` 也应设为 `https://trip.seatraces.com`。独立本机测试使用发送替身；SMTP 本机测试仍可用回环 HTTP 地址。更换正式域名需同步修改模板并重新审核。

运行 `node scripts/check-mail.mjs` 检查缺失/无效字段；再运行 `node scripts/check-mail.mjs --verify` 只读核对域名验证与模板审核/变量，不发邮件。成功输出 `ses_domain_and_templates_passed`；不意味着已实际收信，也不能代替发送权限验证。

## 6. 服务器启用

本机 `.env` 不会自动同步到生产。生产文件为 `/home/ubuntu/seatraces-app/backend.env`。只将本节邮件字段安全写入该文件，不替换整个文件，不覆盖服务器原有数据库、地图或模型配置。服务端已有 `MAIL_OUTBOX_KEY` 时必须保留该值；不要用本机值覆盖，否则旧队列无法解密。

先部署支持 SES 的代码版本，再更新配置并重新创建后端容器以加载环境变量。普通容器 restart 不会重读 Docker env_file：

```sh
cd /home/ubuntu/seatraces-app
sudo docker compose --env-file .env.deploy -f compose.yaml up -d --force-recreate backend
```

生产镜像仅包含 `server`、`public` 和基础资料，容器中没有本机 `scripts/check-mail.mjs`。安装器 `deploy/activate-tencent-mail.py` 直接调用镜像内 `server/mail.mjs` 和 `server/services/mail-outbox.mjs` 完成只读核验，也可登录后台“邮件投递”点击核验。安装器不携带凭据，SecretId/SecretKey 由管理员在服务器隐藏输入；先备份原配置、保留已有队列密钥，核验失败恢复原配置。

容器中运行的是新代码且只读核验通过后，再对真实收信验收。此适配不需要新建数据库表，继续使用已有 `mail_outbox`。后台“邮件投递”显示配置核验、队列状态及安全事件日志；生产启用需要记录 `mail.configuration.activated` 操作日志，不记录凭据。

## 7. 收信验收

| 用例 | 操作 | 预期 |
| --- | --- | --- |
| 域名未验证 | 只读校验 | `SES_DOMAIN_NOT_VERIFIED`，无邮件 |
| 模板待审核/拒绝 | 只读校验 | `SES_TEMPLATE_NOT_APPROVED`，无邮件 |
| 变量不匹配 | 模板误用其他变量再校验 | `SES_TEMPLATE_VARIABLES_INVALID` |
| 固定链接不匹配 | 模板域名、用途或路径与配置不同 | `SES_TEMPLATE_LINK_INVALID` |
| 邮箱绑定 | 自己的账号申请绑定自己能接收的邮箱 | 收到验证邮件；点击验证；已验证状态更新 |
| 链接重复使用 | 再次打开已使用链接 | 拒绝，不重复绑定 |
| 找回密码 | 使用已验证邮箱申请 | 收到邮件；可重设密码；旧会话撤销 |
| 修改通知 | 完成密码重设 | 收到密码修改通知 |
| 服务端配置缺失 | 运行配置检查 | 明确缺项，接口禁用发信；不显示密钥 |
| 队列确认 | 后台 `/api/admin/mail/jobs` | 记录目的、状态、尝试次数；不显示地址/令牌 |
| 结果未知 | 已发出请求后断线（仅隔离环境模拟） | `unknown`，不自动重放 |

生产不主动故障注入或给全体用户发邮件。真实收信仅对用户指定的验收邮箱开展。没有邮件时同时查看垃圾箱、腾讯云发送记录和后台队列，不能把供应商受理认定为最终送达。
