# 邮件投递与配置

支持 SMTP 与腾讯云 SES API 两种发送方式。腾讯云服务已由用户开通，发信域名、地址、模板和专用 API 凭据待配置；未发送真实邮件，真实收信尚未验收。腾讯云配置见 [TENCENT_SES_SETUP.md](TENCENT_SES_SETUP.md)。

## 发送链路

现有邮箱绑定与找回密码接口保留。创建一次性令牌后，邮件先进入 PostgreSQL `mail_outbox`，后台每5秒处理一项。请求成功表示已受理发送；供应商接受不等于最终进入收件箱。

- 收件地址、令牌使用 AES-256-GCM 加密后存库；数据库里不保存明文恢复链接。令牌原有摘要、30分钟有效、一次使用规则保留。
- 每次投递前重新检查令牌是否有效、账号是否停用；过期、已使用或被新申请替代的链接不再发送。
- 相同带令牌邮件使用摘要去重，12并发重复只建一个队列项。密码修改通知无令牌，属于独立通知。
- 临时失败最多尝试4次，间隔30秒、120秒、600秒；队列项25分钟过期。明确SMTP拒绝停止重试。
- SMTP DATA阶段结果不明、进程在发送中重启，或SMTP已接受但数据库确认失败，标记 `unknown`，不自动重放，以免反复发送。用户可重新申请链接，新令牌将使旧令牌失效。
- 发送成功立即清除加密内容；其他终态内容到期后清除。保留安全状态元数据用于排障。SMTP无法保证严格的恰好一次投递，不做这个承诺。
- 队列最多1000项待发送，超出明确返回繁忙，不无限积压。不把原始供应商错误、邮件正文、地址或令牌写入状态接口。

## 配置步骤

1. 准备专用发信邮箱与SMTP授权码，或邮件供应商的SMTP凭据；生产建议按供应商指引配置发信域名认证。
2. 在项目本机 `.env` 或服务器独立密钥配置里填写，不提交Git：

```dotenv
APP_ORIGIN=https://trip.seatraces.com
SMTP_HOST=供应商SMTP域名
SMTP_PORT=465
SMTP_USER=发信账号
SMTP_PASSWORD=授权码
SMTP_FROM=发信地址
MAIL_OUTBOX_KEY=32字节随机密钥的Base64
```

3. 在本机终端生成一次随机加密密钥，私下保存并填写上面的 `MAIL_OUTBOX_KEY`；不要把输出发到聊天：

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
```

4. `node scripts/check-mail.mjs` 只显示缺失项，不显示秘密；配置后执行 `node scripts/check-mail.mjs --verify`，检查SMTP连接及认证，不发送邮件。465使用TLS直连，其他端口强制STARTTLS；不关闭证书验证。
5. 备份并迁移 `server/mail-outbox-schema.sql`，重启后端。使用自己的账号发起邮箱绑定并完成收信/点击验证，再验证找回密码、旧链接失效和会话撤销。

加密密钥必须持久化并与备份分开保管。直接更换密钥会使未投递邮件无法解密；先排空队列再轮换。未配置发送渠道或加密密钥时服务明确禁用，不降级为明文队列。

## 腾讯云 SES 适配

`MAIL_PROVIDER=tencent_ses` 通过 HTTPS API 使用已审核模板发送。保持 `/api/auth/*`、`/api/admin/mail/status` 与 `/api/admin/mail/jobs` 接口不变，不增加数据库表。配置状态增加渠道及无效字段名，不返回凭据值。模板只允许 `{{link}}` 变量；密码已修改模板没有变量。

`node scripts/check-mail.mjs --verify` 对 SES 只读核验域名及三份模板，不发送邮件。`sent` 仍表示供应商已受理。SES 请求在发出后断线、超时、内部错误或缺少受理凭证时进入 `unknown`，不自动重放；明确的限流允许队列重试。供应商错误原文不会进入队列记录或状态输出。没有邮件自动切换渠道的机制，避免重复投递。

2026-10-19 本机验证：`TEST_MAIL_OUTBOX=1 TEST_ACCOUNTS=1 node --max-old-space-size=320 --test --test-concurrency=1 test/tencent-ses.test.mjs test/mail-outbox.test.mjs test/accounts.test.mjs`，24 项通过、0 失败、0 跳过。使用隔离 PostgreSQL schema 和发送替身，无生产数据或真实收信覆盖。

## 排障接口

需要独立后台会话和 `system.read` 权限。

| 接口 | 输出 |
|---|---|
| GET `/api/admin/mail/status` | 配置是否齐备、缺项名、各状态数量；没有配置值 |
| GET `/api/admin/mail/jobs?offset=0` | 每页30条ID、用途、状态、尝试次数、安全错误码和时间；无收件地址或内容 |

测试：加密/篡改检测和隔离数据库集成2项通过，覆盖12并发去重、真实令牌摘要检查、失效拒发、重试、结果不明、重启、清除内容和权限。发送端使用确定性替身；真实SMTP与收信待用户配置后验收。

实现沿用已有 Nodemailer：[SMTP文档](https://nodemailer.com/smtp)。
