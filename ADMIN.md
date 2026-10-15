# 管理后台

入口 `/admin.html`，沿用现有 Cookie 登录；普通用户 403，游客 401。管理员登录后，“我的”显示后台入口。没有默认管理员或默认密码。

## 本机管理员

先正常注册账号；负责人确认账号名后，在项目目录执行 `node scripts/set-admin.mjs <账号名> --local`。仅对本机已有且未停用的账号授予管理员身份并记录审计；本轮不自动提升任何已有用户。服务器管理员需另行由数据库维护人员配置，不把本机脚本指向线上。

## 接口

所有写请求沿用 `X-Seatraces: 1`。所有后台接口每次重新校验会话和管理员身份。

| 方法 / 路径 | 输入 | 功能 / 返回 |
|---|---|---|
| GET `/api/admin/overview` | 无 | 用户数、停用数、24 小时操作/错误数、数据库连接、进程运行时间、内存和日志队列状态 |
| GET `/api/admin/users` | `q`（账号/昵称）、`state` all/active/disabled、`role` all/user/admin、`limit` 1–100、`offset` | 分页账号摘要；不返回密码散列、邮件令牌、Cookie |
| PATCH `/api/admin/users/:id/status` | `disabled` 布尔、`reason` 为 support/security/requested | 停用/启用普通用户；停用删除会话；不能操作自己或管理员 |
| GET `/api/admin/events` | `from/to` 日期、可选 `userId/kind`、分页 | 按时间倒序查询轨迹、接口操作、管理审计和系统错误 |
| GET `/api/admin/events/export` | 同上日期及用户/类别过滤 | 下载 `seatraces-operations.log.gz`；解压后每行一个 JSON 日志；最多 31 天 / 20,000 条，超限明确拒绝，不截断 |
| GET `/api/admin/tasks` | 无 | 最近 50 条地点导入任务的状态，非任意系统进程列表 |
| POST `/api/activity` | `page` 枚举、`action` open/select/save/cancel | 记录本人应用内操作；不接收任意文本、坐标、URL 参数；游客拒绝 |

日期筛选按北京时间自然日，结束日期包含当天；未指定时最近 7 天。`operation_events` 是 PostgreSQL 表，管理变更与审计同一事务提交。普通接口/页面事件批量写入，内存队列最多 2,000 条，每秒最多批量 100 条；故障/过载计数显示在后台，进程退出前尚未落库的普通事件可能丢失。管理审计不经此队列。

不记录请求体、密码、密钥、对话文本、完整查询 URL、精确位置或设备指纹。系统异常仅记录随机请求 ID 和安全错误码。日志导出采用固定数据库查询，不读取任意服务器路径，不打包 `.env`、数据库文件或运行目录。日志暂无自动删除任务，管理员应根据实际业务与保留期限安排维护；不声称永久存储无限容量。

本轮数据库迁移新增 `users.disabled_at` 与 `operation_events`，不会删除现有账号或行程。现有自动部署会拦截 SQL 变更，服务器验收前须先备份并审核迁移。

## 站内信

管理员创建草稿、预览收件范围后确认发送；用户在“我的 → 设置 → 消息”查看。所有内容按纯文本显示。管理员只能修改自己创建的草稿；已发消息不可编辑或撤回。停用账号不接收群发，发送事务固定当时的有效收件人，之后注册者不会补收旧消息。外部邮件通道尚未启用。

| 方法 / 路径 | 输入 | 返回 / 行为 |
|---|---|---|
| GET `/api/admin/messages` | `limit/offset` | 本人草稿与发送记录、收件/已读人数 |
| POST `/api/admin/messages` | UUID `id`、`title`≤80、`body`≤4000、`audience` all/selected、`recipientIds`≤500 | 创建草稿；相同 ID 和内容幂等；指定用户必须有效 |
| GET `/api/admin/messages/:id/preview` | 消息 ID | 正文、草稿版本、有效收件人数、指定用户标签 |
| PUT `/api/admin/messages/:id` | 创建参数及 `version` | 乐观锁修改草稿，旧版本 409 |
| POST `/api/admin/messages/:id/send` | `version`、`recipientCount`、`confirmation: "send"` | 确认并发送；收件人数变化 409；重复发送不重复投递 |
| POST `/api/admin/messages/:id/cancel` | `{}` | 幂等取消草稿，已发送拒绝 |
| GET `/api/me/messages` | `limit/offset` | 本人消息与未读数量 |
| GET `/api/me/messages/:id` | 消息 ID | 本人消息正文；非收件人 404 |
| POST `/api/me/messages/:id/read` | `{}` | 幂等标记已读 |

数据存入 PostgreSQL `inbox_campaigns` 和 `inbox_messages`，不是 JSON 文件。发送、投递记录、管理审计在同一事务；异常全部回滚。日志不复制消息正文或收件人名单。

## 站内信测试

`TEST_INBOX=1 node --test test/inbox.test.mjs` 使用隔离 schema 验证群发、并发重放、收件人权限、已读和长度限制，无 SMTP 调用。

本机服务启动后，PowerShell：`$env:TEST_OPERATIONS='1'; node --test test/operations.test.mjs`。测试使用隔离 schema，结束删除测试数据；不会请求地图或模型 API。用例/结果见 `TEST_CASES_20261016.md`。

## 账户与审计详情

- `GET /api/admin/users/:id`：基础资料、邮箱是否已验证、操作数、最近操作、有效会话创建/到期时间（最多 100 项）。不返回密码散列、邮件地址、Cookie 或会话令牌。
- `POST /api/admin/users/:id/sessions/revoke`：`{confirmation:"revoke",reason:"security"|"support"|"requested"}`，撤销普通用户全部会话；不删除账号或行程，不可操作管理员。并发重复只撤销已有会话一次，审计与撤销原子提交。
- `GET /api/admin/events/:id`：日志详情、请求 ID、资源 ID、受控审计字段。

后台采用独立标准管理台样式，支持窄屏横向表格和侧栏切换；消费者界面保持原有风格。不会通过界面修改用户角色或授予管理员。
