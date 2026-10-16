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
| 用户与轨迹 | 用户全景、可靠业务事件、操作时间线、基础总览 | 全景、时间线、可靠事件、趋势与转化漏斗已通过本机验收，待部署 |
| 旅行与智能体 | 行程与路线分析、执行链、地点质量 | 智能体执行链、行程详情、版本对比、地点质量本机验收通过；云端去重覆盖端点待部署核对 |
| 运营与维护 | 分群留存、消息效果、内容治理、任务、告警、归档 | 分群、留存、消息效果、内容治理本机验收通过；任务、告警、归档待完成 |

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
| `/timeline` | `from/to` 北京日期≤31天、`source` all/operation/business/product、`type` all/navigation/request/admin/trip/citywalk/journey/memory/agent、分页 | 软件操作、历史保存记录、可靠业务事件合并；同一保存记录去重；不补造历史点击 |
| `/trips` | 分页 | 行程标题、城市、起止日期、天数、状态、版本、时间 |
| `/citywalks` | 分页 | 路线标题、城市、地点数、距离、核验状态、版本、时间 |
| `/preferences` | 无 | 账号设置、已确认记忆、强度、置信度、过期状态；行为推断暂标为未接入，不返回原始对话证据 |
| `/visits` | `kind` wishes/marked/presence/favorites、分页 | 想去、用户标记、既有检测、收藏帖子分别查询，包含来源；无名称时不伪造地点名 |
| `/messages` | 分页 | 已投递消息标题、送达和已读时间，不返回正文 |

分页默认 30 条，`limit` 1–100，`offset` 0–10000，返回 `items/hasMore`。累计行程、用户标记完成、标记到访和检测记录是不同指标。个人时间线默认最近 7 天；列表按时间与 ID 稳定排序。业务版本时间不是当时完整页面轨迹，字段以明确的来源呈现。

## 可靠业务事件

`product_events` 由数据库触发器与业务数据同事务写入，覆盖规划会话创建/候选准备/问题准备/完成、行程保存/更新/状态变化、CityWalk 草稿/保存/更新、确认偏好、AI 操作状态。回滚不会留下成功事件；相同记录的幂等重放和未改变内容的更新时间刷新不产生重复创建事件。`analytics_settings.started_at` 记录采集起点，不向历史记录补造事件。

事件字段为 `id,user_id,event_type,resource_type,resource_id,entity_version,flow_id,request_id,source,properties,created_at`。`properties` 只含代码规定的计数、版本、状态、能力编号等摘要，不复制坐标、原始输入、对话、密码、Cookie 或模型响应。服务器生成请求 ID；只在数据库事务内部设置关联上下文，连接归还后不会泄漏到下一个请求。非 HTTP 业务写入仍产生数据库事件，`request_id` 为 null，不伪造操作者。

当前来源 `database` 表示业务写入证据，不能直接判为用户手动或 AI 代操作；细分执行来源将在智能体执行链阶段关联。规划会话与生成的行程共用 flow ID；CityWalk 保存通过已校验的草稿 ID 关联。不同用户的 flow 分开查询。现有导航/请求日志仍保留其有限队列语义。

迁移新增 2 张表及 6 个触发器，重复执行不重置数据或采集起点。原始事件保留配置默认 90 天、汇总 12 个月，目前尚未启用自动归档删除；保留任务随任务中心单独验收后启用。

## 运营分析接口与口径

新增 `server/operations/analytics-schema.sql`：用户统计排除标记及查询索引。只读汇总允许管理员、运营、分析员访问；个人范围设置仅管理员。所有日期按北京时间自然日，默认最近 7 天（含今天），最大 31 天，未来日期和反向日期返回 400。范围选择以注册时间截止到期末，角色与测试排除标记以当前值重算历史；停用不删除历史统计。

| 接口 | 参数 | 返回 / 行为 |
|---|---|---|
| GET `/api/admin/analytics/overview` | `from/to` | 活跃、新注册、保存行程与 CityWalk，零补齐每日趋势，采集覆盖与指标定义 |
| GET `/api/admin/analytics/funnels` | 同上，`kind` journey/citywalk/agent | 按同用户同流程按序匹配；7 天转化窗；重复事件去重，仍在观察与已结束观察分列 |
| GET `/api/admin/analytics/retention` | `from/to` 注册队列范围 | 次日、第 7/30 天精确日留存；观察期未满或该日采集不完整时返回 null，而非零 |
| GET `/api/admin/analytics/segments` | `from/to` | 新用户、活跃、无行为、规划者、CityWalk 保存者、AI 操作成功者等重叠分群，仅汇总 |
| GET `/api/admin/analytics/scope` | 可选 `q`≤80 | 留空列已排除测试账号；有词查账号/昵称，最多 30 条；后台人员自动排除 |
| PATCH `/api/admin/users/:id/analytics` | `excluded` bool，`confirmation:"change-analytics-scope"` | 修改测试标记并同事务审计；不删除记录、不改变登录权限；可恢复 |

活跃仅包含页面行为和可靠业务事件，不含后台访问、接口心跳和纯读取。保存数量从当前仍存在的业务记录按创建日统计；不是包含历史删除记录的累计创建量。转化从创建规划会话开始，不声称已覆盖创建会话之前的全部问卷点击。CityWalk 以草稿 flow ID 关联保存；AI 以 action ID 关联状态，避免同一会话多次操作串线。所有汇总含 `window/coverage`，不返回账号、原始对话或精确位置。

运营页提供趋势、转化漏斗、留存、分群及管理员统计范围页。采集起点之前的空记录不代表真实零行为。首次上线会有观察期，需要真实使用积累后才能判断留存；不补造历史轨迹。

## 智能体执行链

后台新增“智能体执行链”，仅管理员具有 `agent.read`，用户全景中的 AI 会话可直接带用户过滤跳入。会话列表和轮次详情均审计读取。此版本不提供后台重放、代确认、修改工具参数或绕过用户权限的入口。

| GET 接口 | 参数 | 返回 |
|---|---|---|
| `/api/admin/agent/conversations` | `from/to`≤31天、可选 `userId`、`state` all/issues/pending、`limit`1–50默认20、`offset`≤10000 | 会话账号、轮数、最近意图、失败和待确认计数、更新时间；无原始对话 |
| `/api/admin/agent/conversations/:id` | UUID、同上分页 | 当前页轮次、同轮次工具调用、确认操作、按请求ID关联的已提交事件；不返回请求正文/原始输入/回答全文/参数/密钥 |

`agent_turns` 新增 `finished_at,duration_ms,server_request_id`。原 `request_id` 仍为客户端幂等编号；新的服务器请求编号单列。`agent_tool_calls` 新增轮次/操作关联、父请求/内部接口请求编号、耗时、结束时间及 pending/http_success/http_error/network_error 状态。新工具日志只保留 URL 路径，不保存搜索参数；旧日志在管理接口返回时也去掉查询串。网络失败不伪造 HTTP 状态码，不自动重试。

执行链为服务器请求 → 轮次 → 已授权的内部 HTTP 调用 → 返回的服务器请求 ID → 同用户的事务业务事件。直接写入的确认偏好也可通过轮次服务器请求关联。旧记录没有关联编号的，不按时间猜测，单列“历史未关联调用”；旧耗时保持 null。

意图展示三分类及需要澄清的状态；仅展示已有分类来源/分数、澄清选项数量、固定流程步骤、知识引用编号/版本和检索方式。规则置信分是配置值，并非通过真实样本验证的准确率。轮次“已回复”、工具“HTTP成功”和操作“成功”是不同状态。Token/模型账单未逐轮采集，返回 null，不把预算预占当实际费用。

单页轮次最多50，工具与业务事件最多500，操作最多100；达到上限返回明确截断标记。敏感读取都有管理审计；不存在404、无登录401、角色越权403。

## 旅行与路线

仅管理员和客服允许 `journeys.read`。可从菜单或用户全景的历史行程、CityWalk 跳入独立详情页。读取均记录审计；不返回精确出发位置或原始模型/地图响应。

| GET 接口 | 参数 | 输出 |
|---|---|---|
| `/api/admin/journeys` | kind trip/citywalk、from/to 更新日期≤31天、q 标题/账号、userId、state、分页 | 当前仍存在路线摘要；trip 状态 planned/completed，CityWalk verified/unverified |
| `/api/admin/journeys/trips/:id` | 可选 version 正整数 | 指定已保存 plan、每日地点与时间、吃住选择、可用版本列表；标题/问卷/状态为当前值，明确历史范围 |
| `/api/admin/journeys/trips/:id/compare` | fromVersion/toVersion | 每日新增、移除、顺序位置变化、时间/锁定变化和吃住选择差异；按保存快照比较 |
| `/api/admin/journeys/citywalks/:id` | 路线 UUID | 当前站点顺序、距离和核验状态；无历史快照时 historyAvailable:false |

列表默认30条最多100；详情最多31天、每一天100个地点、100个版本；截断明确标记。没有记录的旧版本返回404，不能用另一个行程的版本代替。完成标记不等于实际到访；未核验的保存距离不当作实际步行距离。

## 消息分群与投递效果

- `GET /api/admin/messages/audience?segment=new|active|inactive|planners|walkers`：近7天注册/活跃、近30天无已记录活动、已有行程/CityWalk。仅有效普通用户，排除后台成员和标记测试账号；结果为当前收件人快照，超过500人返回422，不截断。界面把名单填入原有 selected 草稿，仍走保存→预览→确认发送。
- `GET /api/admin/messages/:id/effects?state=all|read|unread&limit=30&offset=0`：仅本人创建的消息，投递及首次阅读汇总、最近31天阅读趋势、分页收件人。不存在或他人的消息404；客服/分析员403。
- 投递是数据库站内信记录，不代表邮件送达或用户看过通知。发送时总人数保留；已读率以现存收件记录为分母，同时列出已删除收件记录。未接入点击转化，不生成转化结论。查询记录管理审计，不复制消息正文。

## 地点质量

管理员/运营具有 places.read。只读查询，不改变地点类别、关系或原始库，不调用付费地图/模型补全。

| GET 接口 | 输入 | 结果与边界 |
|---|---|---|
| `/api/admin/places/quality` | 无 | 业务库分类/状态/缺失名称/景点开放规则/来源链接，补充层级及评分缓存过期数；不冒充 OSM 全库统计 |
| `/api/admin/places/coverage` | 无 | 既有 OSM coverage/site/hierarchy/entity 四种报告；各自失败隔离，同进程一分钟复用并合并并发检查；只投影数字/版本，不返回服务器备份路径 |
| `/api/admin/places/search` | q 2–120字，scope cloud/local | 最多30条质量检查，不推算全库缺失率；快照明确标记 |
| `/api/admin/places/inspect` | id | 别称、分类、来源、资料状态、坐标角色、独立site与parent、最多8级上层/30子地点；读取审计 |

没有开放时间仅对游玩类别提示待补；餐饮住宿不因此阻止推荐。资料待复核、无边界和无已确定父级不混为一谈。官方资料只展示已存在的来源和核验状态，不宣称本次在线重新核验。

2026-10-16只读云端验收：原始导入4,567,502行（含跨区重复可能），8个区域；几何构建覆盖4,566,067地点、190,937子关系、实际最大5层，配置上限8层。实体覆盖接口当前404，界面标记“云端未提供”；不据此断言实体数据不存在，待服务器升级时核对该服务版本。恢复的是此前批准的只读隧道，没有新增权限。


## 内容治理

管理员和运营通过 content.manage 查看已发表帖子/评论、待处理报告，并可隐藏或恢复内容。此入口不修改作者的私有行程，不物理删除内容；隐藏状态同时约束公开推荐、评论读取、点赞/收藏新增和浏览计数。原作者仍可在自己的发布记录中看到内容，重复分享不会绕过隐藏状态。

- GET `/api/admin/content`：kind=posts/comments，state=all/visible/hidden，q≤80，分页默认30最多100。
- GET `/api/admin/content/:kind/:id`：公开内容正文及作者、状态、版本，不返回行程快照。
- PATCH `/api/admin/content/:kind/:id/visibility`：hidden、version、reason=spam/abuse/inaccurate/other、confirmation=change-visibility；版本冲突409。审计与状态变更同事务，失败回滚。
- POST `/api/content/reports`：已登录用户提交 id、kind、targetId、reason；同一编号幂等，同用户同目标的未结报告合并。报告不会自动隐藏内容。首版预留消费者入口，不新增发现页面按钮。
- GET `/api/admin/content-reports`：state=open/resolved/dismissed，分页。
- PATCH `/api/admin/content-reports/:id`：state=resolved/dismissed、version、confirmation=resolve-report；处理报告不代替隐藏操作。

迁移为 posts/comments 增加 hidden_at、moderation_version，以及 content_reports 表。原数据保留，默认不隐藏。只对后台进行网页验收，发现前端仍不在本批测试范围。

网页验收已在隔离测试库完成内容列表、详情、隐藏和恢复，状态与版本即时更新；确认框布局已核对。截图 `validation/admin-operations/moderation.png` 仅保留在本机。
