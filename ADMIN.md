# 管理后台

入口 `/admin.html`，未通过后台认证时由服务器重定向到 `/admin-login.html`。使用现有管理员账号和密码单独登录，不继承旅行应用的登录状态，没有默认管理员或默认密码。

后台使用独立 `st_admin` Cookie（生产环境 Secure、HttpOnly、SameSite=Strict），固定有效期 30 分钟。应用的 `st_session` 和管理会话不可互换；数据库沿用 `sessions`，管理令牌使用独立散列前缀，不新增表。每次管理请求重新检查数据库中的账号角色、停用状态和会话到期时间。退出后台只撤销管理会话，旅行端登录保留；重设密码已有的全会话撤销也覆盖管理会话。

后台 HTML 已移出 `public/`，由经过认证的后端返回，响应禁止缓存。前端服务不能在后端失联时回退展示后台页面。应用内已登录管理员也必须先完成独立后台登录。所有 `/api/admin/*` 统一经过后台认证，普通用户应用会话返回 403，游客或仅有管理员应用会话返回 401。

## 本机管理员

先正常注册账号；负责人确认账号名后，在项目目录执行 `node scripts/set-admin.mjs <账号名> --local`。仅对本机已有且未停用的账号授予管理员身份并记录审计；本轮不自动提升任何已有用户。服务器管理员需另行由数据库维护人员配置，不把本机脚本指向线上。

## 接口

所有写请求沿用 `X-Seatraces: 1`。所有后台接口每次重新校验会话和管理员身份。

| 方法 / 路径 | 输入 | 功能 / 返回 |
|---|---|---|
| POST `/api/auth/admin/login` | `username`、`password` | 管理员密码校验，返回安全账号摘要与 `expiresAt`，设置独立 Cookie；和应用登录共享账号失败次数限制 |
| GET `/api/auth/admin/me` | 管理 Cookie | `{user,expiresAt}`；无有效后台会话时均为 null |
| POST `/api/auth/admin/logout` | `{}` | 撤销当前后台会话并清 Cookie；不退出旅行端 |
| GET `/api/admin/cities` | `q`，最多 100 字符 | 后台经典路线编辑的城市搜索，最多 10 条；不依赖旅行端会话 |
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

后台采用独立标准管理台样式，支持窄屏横向表格和侧栏切换；消费者界面保持原有风格。管理员身份仍由负责人维护；可在“权限与人员”给现有普通账号授予运营、客服、只读分析权限。

## 经典 CityWalk 管理

后台“经典 CityWalk”提供新增、站点搜索/排序、来源记录、核验保存、预览和下架。参数与核验规则见 `CITYWALK_API.md`。下架不会删除记录；启动种子不会覆盖已编辑内容。

## 后台运营升级进度

本次目标覆盖用户全景、软件操作时间线、业务漏斗、旅行与 CityWalk、智能体执行链、地点质量、消息与社区治理、受控任务和归档。只记录登录用户的软件操作和已有到访，不增加持续 GPS 采集，不建立游客个人轨迹。发现界面暂不做视觉验收。

| 阶段 | 交付范围 | 状态 |
|---|---|---|
| 权限基础 | 四类角色、独立登录、权限撤销、管理审计 | 本机 28 项测试与管理员/分析员网页验收通过，待部署 |
| 用户与轨迹 | 用户全景、可靠业务事件、操作时间线、基础总览 | 全景与历史时间线本机已验收；可靠事件和统计待开发 |
| 旅行与智能体 | 行程与路线分析、执行链、地点质量 | 待开发 |
| 运营与维护 | 分群留存、消息效果、内容治理、任务、告警、归档 | 待开发 |

每个功能独立提交 Git。已有业务数据用于查询和汇总；过去未采集的操作不补造。所有新增统计应提供口径、时间范围和更新时间。

## 后台角色权限

`admin_memberships` 单独保存普通账号的后台角色、启用状态、权限版本和变更人，不改变 `users.role`。现有管理员自动保留管理员权限，迁移不提升任何普通用户。

| 角色 | 允许范围 |
|---|---|
| 管理员 | 已登记的全部后台功能，角色分配与撤销 |
| 运营 | 汇总、用户列表（消息收件人）、经典路线、站内信、地点查询 |
| 客服 | 汇总、用户详情、用户操作记录、行程查询；不能导出日志或停用用户 |
| 只读分析 | 汇总与统计；不能查看个人资料、明细日志或修改数据 |

所有 `/api/admin/*` 先验证独立后台 Cookie，再匹配 `server/operations/permissions.mjs` 的方法和路径白名单。未登记的接口对管理员也默认拒绝。角色撤销或变更会失效该账号的所有后台会话，保留旅行端会话；每次请求检查角色版本与停用状态。页面菜单按同一权限集显示，不能替代后端校验。

| 方法 / 路径 | 输入 | 输出与约束 |
|---|---|---|
| GET `/api/admin/access` | 后台会话 | 当前 `access`（role/name/permissions/version）、角色定义 |
| GET `/api/admin/access/members` | 可选 `q`≤80、`offset` | 每页 30 条，`items/hasMore`；空搜索仅列后台成员；仅管理员 |
| PUT `/api/admin/access/members/:id` | `role` operator/support/analyst/null、当前 `version`、`confirmation:"change-role"` | 新 role/enabled/version；null 撤销；旧版本 409；审计与变更同事务 |

不能通过该接口提升为管理员、修改自己的权限或修改既有管理员；停用账号不能获得权限。`GET /api/auth/admin/me` 新增 `access` 字段，原 `user` 与 `expiresAt` 保留。普通角色看到的总览不包含进程内存、运行时间和日志队列诊断。

## 用户全景和历史时间线

入口为用户列表的“用户全景”，使用独立页面路由 `/admin.html#/users/:id/:tab`，支持浏览器前进、返回和刷新。概览中的收藏、标记到访和检测到访分别进入对应明细。

以下新增接口仅管理员和客服可读；每次读取均在 `operation_events` 写入操作者、目标用户、请求 ID 和受控角色信息。运营只能读取收件人基础列表，只读分析不能读取个人明细。不存在的账号返回 404；无后台会话 401、越权 403、参数错误 400。

| GET 接口（前缀 `/api/admin/users/:id`） | 参数 | 主要输出 |
|---|---|---|
| `/summary` | 用户 UUID | 安全用户摘要、全部已保存数据计数、最近 5 个行程、近 7 天服务失败数；不包含精确出发位置、密码、邮箱地址、对话 |
| `/timeline` | `from/to` 北京日期≤31天、`source` all/operation/business、`type` all/navigation/request/admin/trip/citywalk、分页 | 操作事件与真实业务保存时间合并；`source` 明确来源；不补造历史点击 |
| `/trips` | 分页 | 行程标题、城市、起止日期、天数、状态、版本、时间 |
| `/citywalks` | 分页 | 路线标题、城市、地点数、距离、核验状态、版本、时间 |
| `/preferences` | 无 | 账号设置、已确认记忆、强度、置信度、过期状态；行为推断暂标为未接入，不返回原始对话证据 |
| `/visits` | `kind` wishes/marked/presence/favorites、分页 | 想去、用户标记、既有检测、收藏帖子分别查询，包含来源；无名称时不伪造地点名 |
| `/messages` | 分页 | 已投递消息标题、送达和已读时间，不返回正文 |

分页默认 30 条，`limit` 1–100，`offset` 0–10000，返回 `items/hasMore`。累计行程、用户标记完成、标记到访和检测记录是不同指标。个人时间线默认最近 7 天；列表按时间与 ID 稳定排序。业务版本时间不是当时完整页面轨迹，字段以明确的来源呈现。
