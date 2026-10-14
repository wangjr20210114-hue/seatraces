# 海迹 SeaTraces

智能旅行推荐原型，2026-10-10。目标：2026“仓颉杯”综合系统赛道。

## 团队共用服务

2026-10-14 已上线 **https://trip.seatraces.com**。浏览器直接打开后注册/登录；API 基址为 `https://trip.seatraces.com/api`。组员使用这个地址，无需启动原开发电脑、SSH 隧道或本机 PostgreSQL。已有账号、历史行程和 CityWalk 已迁入服务器独立的 `seatraces_business` PostgreSQL 数据库，旧登录会话不迁移，需要重新登录。

HarmonyOS 源码默认连接此 HTTPS 地址。已安装旧 HAP 的设备在顶部“连接设置”填入 `https://trip.seatraces.com` 并连接；本次没有重新发布 HAP。服务器运行独立前端与 API 容器，前端不依赖数据库启动；OSM 服务继续使用同机私有端口。详细结构、运维和回滚见 [部署说明](deploy/README.md)。

接口调用沿用标准 Cookie 会话：`POST /api/auth/login`，JSON 为 `{"username":"自己的账号","password":"自己的密码"}`，写请求加 `X-Seatraces: 1`，后续请求保存并发送 `st_session` Cookie。Cookie 是 `HttpOnly; Secure; SameSite=Strict`，有效期 14 天。不要给前端分发数据库连接串、DeepSeek Key 或高德 Web 服务 Key。公共 API 保留鉴权，没有开放数据库或无鉴权的地点服务。

浏览器页面通过同源 `/api` 调用。独立本机前端可用 `FRONTEND_API_ORIGIN=https://trip.seatraces.com npm run frontend` 的进程环境配置通过现有代理联调；PowerShell 写法为 `$env:FRONTEND_API_ORIGIN='https://trip.seatraces.com'; npm run frontend`。服务仍使用 Secure Cookie；正式验收优先使用云端 HTTPS 页面。不要添加 `Access-Control-Allow-Origin: *` 绕过登录限制。

本机 `start.ps1` 仍是独立开发数据库，云端与本机不会自动双向同步。协作演示、账号和新行程统一使用上述云端入口。

GitHub 仓库保存前后端源码、HarmonyOS 工程、数据库建表/迁移、测试与部署脚本。密钥、用户数据库、云端 OSM 原始数据、SSH 凭据、日志、调试截图和构建产物不随源码上传。克隆后需安装依赖，按 `.env.example` 配置自己的环境，并连接已有地点服务；不会自动包含原开发环境的账号和行程。本文及验收记录中引用的 `validation/`、`screenshots/` 为本机开发产物，不在源码仓库中。

本地前端入口：**http://127.0.0.1:8788**；API 后端为 `127.0.0.1:8787`。只保留卡通版，底栏为“旅行 / 发现 / 我的”。未登录先进入独立登录/注册页；已登录的有效 Cookie 会恢复会话。已经移除自动创建演示管理员账号的入口。旅行页提供地图与逐题纸签问卷；发现为路线分享空态，收藏、浏览、旅行报告仍标记“即将开放”。旧版页面源码及 `archive/legacy-ui` 中的备份已删除；旧 URL 仅跳转首页。

2026-10-12 起，`server/frontend.mjs` 独立提供静态前端和 `/api`、`/_AMapService` 同源代理，不导入数据库或模型模块。2026-10-13 增加登录门禁：后端离线时登录页仍可显示，应用启动页显示连接错误与重试按钮；无法确认登录状态时不展示用户行程。已经进入应用后，接口断连会提示重连。当前鸿蒙客户端在线加载 Web 页面，并非把完整前端离线打进 HAP；若电脑前端也关闭或模拟器端口映射丢失，客户端显示原生连接错误与重试按钮。

## CityWalk 与首页（2026-10-13）

首页已移除“出行计划”列表；“我的 → 历史行程”保留全部已存行程和分页加载，没有删除 `trips` 数据。制订按钮下依次为“经典 CityWalk”和“我的 CityWalk”。经典卡片包含城市和路线名称，默认每秒轮播，支持触摸滚动、键盘左右键、圆点切换与暂停；手动操作、鼠标停留、卡片键盘焦点、问卷开启及页面不可见时暂停。系统要求减少动画时默认不自动播放。

新增独立编辑页 `/#/citywalk/new`、`/#/citywalk/<id>`，按“城市 → 片区 → 景点”选择，支持多个片区、搜索候选、增删地点、更换起点、保存和再次编辑。城市去重和卡通边界 SVG 位于 `public/city-selection.js`，与原问卷共用；后端共用 `citySelectionForUser`，读取当前父景点、评分及用户偏好。候选列表每次展开 30 条，列表分页不减少所选片区的候选总量。单条可选 2–100 个地点。

`public/citywalk-route.js` 使用最近邻与开放路径 2-opt，在固定所选起点的情况下缩短地理连线，不保证全局最优。地图复用高德 JS 底图和现有平滑示意曲线，缩放不会切到空的跨城视图。距离为 WGS84 相邻坐标的球面距离之和，不是实际道路步行距离；排序不调用 LLM 或付费路径矩阵。经典内容为官方文旅资料中的精选路线灵感（来源链接在编辑页），打开时只按本库名称/别名唯一匹配；无法唯一匹配的地点明确提示用户补选，不编造坐标。当前先提供上海、北京、杭州三个卡片。

持久化新增 PostgreSQL 表：`citywalks`（id、user_id、title、city、stops、cluster_ids、distance_m、version、created_at、updated_at）及 `citywalk_drafts`（id、user_id、city、catalog、expires_at，24 小时有效）。用户路线不保存为 JSON 文件；city/stops/catalog 是表内 JSONB 快照。当前仍是本机业务 PostgreSQL，未把该业务表迁移到云端 OSM 主库。接口位于 `server/services/citywalk-service.mjs`：GET `/api/citywalk/catalog/:cityId` 通过短轮询读取片区，GET/POST `/api/citywalks`，GET/PUT `/api/citywalks/:id`。接口要求登录、按用户隔离；保存只接收地点 ID，在服务端核对目录与范围、重算顺序和距离，更新要求版本一致。

检查：`npm run check`；`$env:TEST_CITYWALK='1'; node --test test/citywalk.test.mjs` 使用本机 PostgreSQL 独立测试 schema，完成后清理测试 schema。无需模拟器即可验收前后端流程。

## 用户数据库与账号实施计划（2026-10-13）

当前业务库实测为 **PostgreSQL 18.4**，存放在本机 `.runtime/pg`；云端 OSM 地点库为另一套 PostgreSQL/PostGIS。用户、会话、行程、头像均使用数据库表，不使用 JSON 文件作为用户存储。表内 JSONB 用来保存可变问卷和完整行程快照，仍由 PostgreSQL 管理事务、索引和备份；`.runtime/local.json` 只是本机开发数据库的连接配置。当前账号改造尚未部署到腾讯云。

本轮已实装最小账号闭环：未登录页面跳转 `/login.html`；所有业务 `/api` 和地图代理都要求会话；注册账号限定 3–32 位英文字母、数字、下划线，以小写规范化并由数据库唯一索引判重，账号名不提供修改接口。内部主键仍为 UUID，昵称可修改。密码 bcrypt 成本 12、至少 8 字符且最多 72 UTF-8 字节。浏览器仅持有随机会话 Cookie（HttpOnly、SameSite=Strict、14 天；生产环境 Secure），数据库只保存会话摘要；登录替换当前旧会话，退出立即撤销，重置密码撤销该用户所有会话。不将会话令牌放入 localStorage。

“我的账号”可保存昵称、六款预设头像或上传自己的静态照片。上传后在服务端重新编码成 256×256 WebP，剥离原照片元信息，以 `bytea` 存储在 `user_avatars`；当前头像接口只允许本人读取。社区开放时另加经过授权的公开头像接口。邮箱须先在账号内输入当前密码发起绑定，再点击邮件验证；只有验证后的邮箱能找回密码。邮件令牌随机生成、数据库只存摘要、30 分钟过期、一次使用；找回申请对存在和不存在的邮箱返回相同提示。正式邮箱更换流程暂未开放，避免覆盖已有恢复地址。

底栏采用三个独立的 Lottie SVG 实例（本地打包的 lottie-web 5.13.0，许可见 `public/vendor/lottie-LICENSE.md`），只有真正切换栏目时播放一次。重复点击当前栏目平滑回顶，减少动态效果设置下直接回顶。去掉底栏浮动背景和触摸高亮，保留键盘焦点提示。

建议按以下模块逐步完善，**标记“规划”的表和字段尚未创建**：

| 模块 | 表与主要字段 | 状态与对旅行推荐的作用 |
| --- | --- | --- |
| 账号与安全 | `users(id, username, password_hash, role, password_changed_at, created_at)`；`sessions(token_hash, user_id, created_at, expires_at)`；`user_emails(user_id, email, verified_at)`；`account_tokens(token_hash, user_id, purpose, email, expires_at, used_at)`；`auth_rate_limits` | 已实现。唯一身份、会话撤销、已验证邮箱恢复；密码/邮箱/令牌不能传给 LLM。 |
| 个人资料 | 当前 `users.nickname/avatar` 与 `user_avatars(user_id,image,updated_at)`；规划 `user_profiles(user_id,nickname,avatar_id,home_city_id,timezone,language,updated_at)` | 昵称和头像已实现。后续常驻城市辅助出发地、时区处理日期；按需填写，不要求真实姓名、性别或生日。资料独立拆表时保持现有 API。 |
| 明确旅行偏好 | 当前 `users.preferences`；规划 `user_travel_preferences(user_id,pace,transport,crowd,revisit,walking_limit_min,budget_min,budget_max,currency,updated_at)` 与 `user_interest_preferences(user_id,interest_id,weight,source)` | 当前兴趣、节奏已有持久化。本次问卷的交通、拥挤偏好仍保存在问卷/行程快照中；下一阶段再增加“记住偏好”。一次旅行选择优先于长期偏好。预算/步行范围允许为空，不虚构默认喜好。 |
| 用户与地点 | `user_place_wishes(user_id,place_id,wanted,updated_at)`、`user_place_visits`、`user_place_presence`；规划补充 `source/confidence/observed_at`，及独立“不想去/不再推荐”反馈 | 已有想去、到访和停留记录。优先调度想去地点；到访推断保留来源和可信度，允许纠正。点“想去”、加入计划、实际到访是三件事，不能互相代替。 |
| 问卷与行程 | `journey_sessions`、`trips(user_id,request,plan,status,created_at,updated_at)`、`trip_versions` | 已有。保存本次约束、候选及最终安排，支持恢复、修改、版本追溯；从执行后反馈估计游玩时长和重游倾向。必须按 `user_id` 验证所有权。 |
| 发现与行为 | 现有 `posts/reactions/comments/browse_events`；规划独立收藏目录、曝光/跳过/不喜欢事件及告知版本记录 | 后台部分已有，前端仍为空壳。登录用户的应用内帖子浏览事件固定记录并参与推荐，不提供开关；曝光与点击分开，避免把看见当喜欢；负反馈可覆盖推荐。 |
| 派生推荐画像 | 规划 `user_interest_scores(user_id,feature,score,confidence,signal_count,updated_at,algorithm_version)` 与 `recommendation_feedback` | 尚未实现。显式偏好和“想去”优先，收藏/点击/停留作弱证据并随时间衰减；每项分数可追溯、可重算。先用规则统计，积累反馈后再引入相似用户推荐。 |

关系原则：所有用户表通过 UUID 外键关联账号；账号名仅用于登录与显示。地点引用使用稳定规范地点 ID，合并后的旧 ID 先经地点库别称/实体解析；云端 OSM 与业务库分开，不能用跨数据库外键假装已经强关联。行程保存生成时地点快照，后续地点更新不会悄悄重写历史。头像目前按本人读取，社区中公开哪些资料需要在开放社区前确定。

实施顺序：

1. **本轮：账号底座与底栏。** 基础登录、头像、邮箱接口完成；SMTP 未配置，真实收信与找回链路仍待验收。旧账号和行程不删除。旧版自动生成的 `demo_<8位十六进制>` 管理员会话不再获得业务访问权限；持有该设备旧会话的用户注册时，可主动勾选“保留当前设备的体验行程”，保留原 UUID 及记录、设置正式账号密码并降为普通用户，同时撤销旧会话。不勾选就创建独立账号；不跨账号自动合并。
2. **下一步：明确偏好闭环。** 做“记住本次偏好”、想去/不想去/到访可纠正，完善字段来源与更新时间；只验收这些偏好确实影响选点和排程。
3. **之后：轻量画像与发现。** 接入应用内曝光、收藏和负反馈，先统计规则评分，再评估推荐采纳率、用户改动次数和满意反馈；不能把长停留或高点击直接等同于满意。
4. **云端部署时：** 业务库单独数据库/最小权限角色，与 OSM 原始库分离；HTTPS 同源代理、生产 Cookie、迁移版本、数据库备份恢复和邮件送达一起验收。多实例部署要把入口限流统一到共享存储，并只信任指定反向代理的客户端地址。本轮账号限流已落 PostgreSQL，入口 IP 限流仍是单进程。

保留策略建议（待下一阶段实现）：过期会话及时清理，邮件令牌过期/使用后最多保留 7 天；浏览明细默认 30 天，画像保留可重算的聚合特征；历史旅行由用户主动管理。现有清空浏览历史接口保留，未来派生画像需同步更新。长期精确 GPS 轨迹不作为默认用户字段。

2026-10-13 调整：应用内浏览行为用于推荐是固定服务规则，账号页仅显示用途说明。帖子浏览接口对登录用户记录事件，旅行偏好和发现推荐使用近 30 天记录，每帖子每天停留累计上限 120 秒。旧 `analyticsConsent` 字段已退出业务规则和公开账号结构，旧客户端提交该字段会被忽略，不再触发删除浏览记录；新账号默认值不含该字段。存量数据库中的旧字段保留为历史数据，不批量改写成用户同意。当前发现前端仍为空壳，需后续接入真实帖子曝光/停留上报；此次没有把普通账号页访问伪装成帖子浏览。

账号、历史旅行、旅行详情、收藏、历史浏览、旅行报告采用全屏页面跳转，顶部统一返回，详情页隐藏底栏。地址使用 `/#/account`、`/#/history`、`/#/history/<id>` 等，支持刷新与浏览器前进/后退；直接打开子页时，顶部返回可回到“我的”（行程详情回到历史列表）。页面切换保留地图和当前 Day，登录页仍是独立的 `/login.html`，已去掉外层浮动卡片。旅行问卷继续使用撕纸界面。历史列表按保存时间读取摘要，每次显示 20 条，进入详情才读取完整行程；收藏、历史浏览、旅行报告仍标注“即将开放”，本轮只调整页面形式。

代码职责：`server/auth.mjs` 负责账号、会话、资料、令牌和鉴权；`server/mail.mjs` 只负责 SMTP 发送；`server/auth-schema.sql` 是保留原数据的增量表结构；`public/login.*` 为登录入口，`public/account-page.js` 为账号资料页，`public/profile-pages.js` 渲染个人中心子页面，`public/page-navigation.js` 管理页面历史与返回，`public/tab-motion.js` 管理独立图标状态。原账号弹窗模块已移除。改造前已在本机 PostgreSQL 的 `account_before_20261013` schema 保存账号/会话快照，不导出用户 JSON 文件。

### 邮箱配置与验收

1. 准备一个允许 SMTP 发信的邮箱/邮件服务，按该供应商说明取得 SMTP 主机、465（隐式 TLS）或 587（强制 STARTTLS）端口、发信用户名和授权码。授权码只留在本机配置中。
2. 在项目目录运行 `powershell -ExecutionPolicy Bypass -File scripts/configure-email.ps1`。填写 `APP_ORIGIN`、`SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_FROM`、`SMTP_PASSWORD`。本机浏览器验收可用 `http://127.0.0.1:8788`；正式部署用实际可访问的 HTTPS 站点，如 `https://seatraces.com`，不能在尚未部署时先填该地址。邮件接收设备必须能访问这个站点。
3. 重启 API 后，在“我的 → 我的账号”输入邮箱和当前密码，发送并点击验证链接。验证前该邮箱不作为恢复地址。点击链接后还有一次“确认绑定邮箱”操作，避免邮件预览机器人自动消费链接。
4. 退出，在“忘记密码”输入已经验证的邮箱，使用邮件链接设置新密码并重新登录。确认旧密码、旧会话和再次使用的链接都被拒绝。没有配置 SMTP 时界面明确提示暂不可用；不打印、返回或伪造验证链接。
5. 当前为单进程简单发送，找回邮件在通用响应后异步发送；发送失败不改变密码，可稍后重新申请。大规模部署前再补可重试的邮件任务队列、告警和退信处理。

安全流程参照 [OWASP 密码找回说明](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)；SMTP 参数参照 [Nodemailer 官方文档](https://nodemailer.com/smtp)；Lottie 独立实例和播放接口见 [官方用法](https://github.com/airbnb/lottie-web/wiki/Usage)。上述链接是实现参考，不表示本原型已经完成生产安全审计。

这是已运行、可修改、可持久化的功能原型。不是全国旅游数据已采集完成的成品，也不是已接通实时票价的上线系统。详细完成状态见 [IMPLEMENTATION.md](IMPLEMENTATION.md)。

交付入口见 [DELIVERY.md](DELIVERY.md)，实测证据见 [TEST_REPORT.md](TEST_REPORT.md)。

2026-10-13 界面更新：城市景点查询改为合并重复任务的后台加载（`?async=1` 返回 202，前端短请求轮询），自有 OSM 瞬时错误重试一次；过期城市快照在 24 小时内可作为明确标记的回退。高德市界先返回，区县边界按原限速队列补齐，不再阻塞整页。只展示外层景点，名称右侧三角展开内层名称；只有外层提供“想去”。区县图放大并去掉边框，问卷纸面及标题使用实色背景。

旅行首页新增按**保存时间从新到旧**排列的“出行计划”，先 10 条，每次再展开 5 条。Day 按当天景点和示意曲线单独适配视野，不含远处城市标记或道路几何；“旅行总览”连接已知出发坐标和依次选择的城市，支持按钮与用户缩放切换。展示曲线仅表示访问顺序，不代表可通行道路或实时耗时；切换 Day 不再触发前端自动算路。原后端算路接口仍保留，导航通过明确选中的相邻两站（或当前位置到首站）唤起高德。其 URI 接口只支持一个驾车途经点，因此没有把任意多站日程伪装成完整导入；模拟器未安装高德 App 时，真实 App 唤起仍需真机验收。旧计划缺少出发坐标时，仅尝试内部城市库唯一同名匹配，无法确认则显示提示。

本次实测北京城市加载约 12.8 秒、重复读取约 2.0 秒，12 片 / 5,043 个外层可选地点 / 1,617 个子景点，属于本次运行样本而非延迟保证。33 项相关测试通过；浏览器已检查故宫折叠、手机尺寸 Day 路线及列表展开，模拟器已加载更新。证据：`validation/cartoon-update-beijing.json`、`validation/cartoon-parent-fold.jpg`、`validation/cartoon-day2-mobile.jpg`。

2026-10-11 新增景点聚类旅行流程：最多 5 城，按选择顺序分配日期，跨城日预留上午。真实 OSM 景点按 900 米邻近关系聚类，每组最大跨度 3.2 公里、最多 24 点，综合分为成员分数之和。问卷结束后 DeepSeek 只返回内部候选引用，后端校验日期、数量和重复；高德对每日相邻点匹配并算路。`journey/2` 行程持久化到 PostgreSQL。此前后台地点与资料工作见 [BACKEND_PHASE1.md](BACKEND_PHASE1.md)、[BACKEND_CANDIDATES.md](BACKEND_CANDIDATES.md)。

新增职责：`server/domain/scenic-clusters.mjs` 负责规则聚类与评分；`services/city-boundaries.mjs` 获取并短期缓存高德区县边界；`city-clusters.mjs` 取自有景点并分区；`journey-draft.mjs` 约束模型与日程；`journey-service.mjs` 管理问卷归属、到访记录、保存和路程。云端只读服务 v5 的 `/cluster-places` 每城市最多 8,000 个候选，超过会标注部分覆盖；`/place-batch` 批量补充原有资料证据。应用数据库新增 `journey_sessions`、`user_place_visits`、`place_signals`，不修改原始 OSM 记录。

当前边界：知名度和人流尚无可靠指标，缺失时不计分；资料丰富程度单独作为代理项，不能理解为真实热度。日程时长与跨城预留为规划假设；开放规则无法确定时仍为草稿。境外可使用已收录 OSM 景点，但区县边界和真实道路服务仍需相应供应商。几何聚类和地点顺序优化不能保证道路完全不交叉。高德边界、匹配候选与道路几何只作短期内存缓存，不批量写入 OSM。本机已配置高德 Web 服务 Key、JS Key 和安全密钥，并于 2026-10-11 验收真实底图、景点标记和步行路线；其他环境需要自行配置。

本轮实测：苏州 745 点 / 329 片，9 区县，首次约 15.7 秒；衢州 608 点 / 474 片，6 区县，首次约 12.4 秒。首次耗时包含限速获取边界。结果见 `validation/journey-cities-live-20261011.json` 和 `journey-quzhou-live-20261011.json`；91 项 Node 与 2 项 Python 检查通过，使用一次性测试数据库，未调用付费接口。

高德与 DeepSeek 的账号申请、本机隐藏输入配置、连接检查和已整理的代码职责，见 [BACKEND_INTEGRATION.md](BACKEND_INTEGRATION.md)。外部调用、业务服务与数据访问已经分离；2026-10-11 已完成真实 POI 搜索、逆地理编码、地点匹配、步行与公交分段、DeepSeek JSON 和自有题库调用验收，主服务已加载配置。汇总见 `validation/provider-acceptance-20261011.json`。

2026-10-11 追加：本机已启用约 24 MB 的 BGE 中文语义排序；3 个苏州景点的 10 条官网资料经 DeepSeek 提取和原文复核，已实际写入云端 `osm.place_facts` 并读回核对。证据、时效范围、模块职责、备份和使用方法见 [BACKEND_CANDIDATES.md](BACKEND_CANDIDATES.md)。该流程为本批受控资料补充，尚未自动搜索全网或定时刷新。

## 启动

在此目录打开 PowerShell：

```powershell
./start.ps1
```

此命令先启动独立前端，再复用或启动 API 后端与现有地点库连接。只看前端（无需数据库）可运行 `./scripts/start-frontend.ps1` 或 `npm run frontend`。前端仅监听本机 8788，默认代理到 8787；可通过进程环境变量 `FRONTEND_API_ORIGIN` 指向独立后端。前端进程不加载 `.env` 或数据库凭据。

本机开发模式中，模拟器每次重启后需要恢复映射：`hdc -t <设备ID> rport tcp:8788 tcp:8788`。`harmony/install-emulator.ps1` 会检查并恢复这个映射；云端模式使用 `https://trip.seatraces.com`，不需要端口映射。旧版 8787 页面入口暂保留兼容，本机体验请使用 8788。

或前台启动：

```powershell
npm ci
npm run dev
```

使用 Node.js 24；前端监听 `127.0.0.1:8788`，API 后端监听 `127.0.0.1:8787`，PostgreSQL 18.4 监听 `127.0.0.1:54329`。`npm run dev` 只启动 API 与数据库，需另开前端进程。不依赖全局 PostgreSQL、Docker 或 Python。数据库持久化在 `.runtime/pg`。不要删除此目录，也不要把 `.runtime/local.json` 作为源码共享。

首次在其他电脑运行后，在另一终端导入随源码附带的开放城市索引：

```powershell
npm run import:geonames
```

## 体验顺序

旅行：点击“制订个性化旅行方案” → 出发地 → 最多 5 城 → 日期 → 每城选择片区（展开景点可标记“想去”）→ 个性化偏好 → 生成保存。当天路线按需获取，刷新后保留最近行程。

发现：当前为卡通空态，可返回地图，不展示虚构帖子或推荐结果。

我的：点击头像管理账号，点击“历史旅行”恢复已有行程；收藏、浏览、旅行报告仅展示待开放状态。切换底栏保留地图、行程及未关闭问卷的内存状态。已有账号的行程归属和访问权限保持隔离。

定位不是演示必需条件，拒绝定位后仍可手动填写。模型未配置时使用明确标注的本地规则助手。

## 工程布局

| 目录 | 内容 |
| --- | --- |
| `server/` | Express API、PostgreSQL 数据模型、规划器、服务商适配器 |
| `public/` | 响应式交互界面、Leaflet 地图、原创 SVG 插画 |
| `public/maps/` | 小范围 OpenStreetMap 离线矢量，ODbL 1.0 |
| `data/geonames/` | GeoNames 原始城市与行政区索引，CC BY 4.0 |
| `harmony/` | ArkTS / ArkUI / ArkWeb 鸿蒙客户端，API 23 |
| `dist/` | 已构建的未签名 HAP |
| `test/` | 规划约束与端到端 API 验收 |
| `deploy/` | PostgreSQL 角色、Nginx TLS 示例与备份脚本 |
| `scripts/osm/` | 国内及八个国外国家 OSM 下载、校验、提取、事务导入、多语言检索、PostGIS 查询与服务器备份 |

## 鸿蒙

DevEco 打开 `harmony/`，SDK 为 HarmonyOS 6.1 / API 23。

```powershell
./harmony/build.ps1
```

已成功生成 `dist/seatraces-0.1.0-unsigned.hap`。这是 ArkUI 容器 + ArkWeb 共享界面的混合原型，业务逻辑在服务端，浏览器与手机共用完整交互界面。

本次在用户处理首次软件协议后，已通过 HDC 将未签名调试包安装到本机 HarmonyOS 6.1 API 23 模拟器并启动，截图已确认 ArkWeb 正常显示“发现”页面。该模拟器允许安装此调试包；真机、其他模拟器或发布环境仍应在 DevEco 的 Signing Configs 使用自己的开发账号完成签名。设备连接后，将本机服务映射进去：

```powershell
& 'D:/SWE-OpenHarmony/DevEcoStudio/sdk/default/openharmony/toolchains/hdc.exe' rport tcp:8787 tcp:8787
```

也可在模拟器启动后，一次完成端口映射、安装和启动（设备 ID 先用 `hdc list targets` 确认）：

```powershell
./harmony/install-emulator.ps1 -DeviceId '127.0.0.1:5555'
```

构建和安装脚本均支持 `-DevEco '你的 DevEco Studio 安装目录'`。构建成功会更新 `dist/` 中的交付包。

2026-10-11 最新模拟器验收：Pura 90 已显示新版高德地图首页和“制订个性化旅行方案”按钮。该模拟器下 ArkWeb 默认异步绘制曾显示黑屏，客户端已改用 `RenderMode.SYNC_RENDER` 并重新安装验证。记录见 `validation/harmony-amap-20261011.json`；此轮只验收启动和地图首页，完整问卷流程与真机绘制需另行验收。体验时保持电脑后端和模拟器端口映射运行。

端内“连接设置”默认 `http://127.0.0.1:8787`；正式部署填写 HTTPS 服务域名，不附带账号、路径、查询参数或片段。编辑地址只修改草稿，点击“连接并刷新”后才应用；关闭设置会丢弃草稿。本机 HTTP 仅允许上述回环地址。定位请求仅接受当前连接服务的同源页面，随后仍由系统向用户申请权限。

2026-10-11 已重新构建并在 Pura 90 / API 23 模拟器安装启动：地点库显示云端 4,567,502 行，实际检索外滩和 `tokyo tower`，东京塔详情可解释当日 09:00–23:00 OSM 规则并保留官网补充说明。鸿蒙返回键可从地点库返回旅行首页；设置草稿与无效地址拦截已实测。安装脚本复用本设备既有 8787 映射，并检查 HDC 输出中的实际成功信息；锁屏失败不会再误报成功。GPS、真实商业地图及完整移动流程仍待验收，详见 TEST_REPORT.md 最新一节。

## 测试

先启动服务，再执行：

```powershell
npm test
npm run check
```

当前 22 项 Node 测试覆盖：日期与闰年、闭园与入园时窗、不重复排程、锁定与替换冲突、坐标转换、名称相似度、步行/地铁/铁路分段与路线排序、沿路线的步行进度、GPS 精度与跳点、转乘段和骑行地图跳转，以及注册登录、跨用户访问拒绝、乐观锁、版本恢复、助手预览、分享去重、互动幂等、浏览时间上限、撤回授权删除记录、旅行报告和接口未配置状态。云端地点 API 与 Python 数据校验另见 TEST_REPORT.md。

API 集成测试会产生以 `test_` 开头的专用账号和帖子；仅在开发数据库执行。禁止将测试指向生产环境。

本机应用数据备份恢复演练：`npm run verify:backup`。脚本在一致性快照中导出 12 张业务表，将磁盘备份恢复到全新临时数据库，逐表比对 SHA-256 后仅清理本次临时库。备份保留在 `.runtime/backups/`，包含账号和会话等私有数据，不随源码分发。这是原型业务表恢复验收；生产仍使用 `pg_dump` / `pg_restore` 并另行演练 PostGIS、权限和灾难恢复。

## 接口密钥

首次配置可复制 `.env.example` 到 `.env`，已有 `.env` 时不要覆盖。填写服务商密钥并重启进程后生效。服务端密钥和 JS 安全密钥不进入 Web、HAP 或帖子；JS API 的公开应用 Key 会按供应商要求用于浏览器加载。

- 高德：`AMAP_KEY`，支持国内地点匹配、步行与公交候选路线。
- DeepSeek：`DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL`，只接收本系统问题库、偏好摘要与可编辑地点集合，返回 JSON，再由后端校验。
- 聚合数据：`JUHE_TRAIN_KEY`，接入火车车次、席别、余票与票价查询。
- Amadeus：`AMADEUS_CLIENT_ID` / `AMADEUS_CLIENT_SECRET`，航班报价；`AMADEUS_PRODUCTION=true` 才是生产服务，测试数据不会标为实时。

高德 Web 服务、JS 地图渲染和 DeepSeek 已在本机配置并完成上述限定范围的真实联调；实时车次和航班票价未验收，不展示虚构实时票务。境外增加了默认关闭的 Google Places / Routes / Maps JS 适配，配置方法见文末；真实境外导航仍未验收，当前可跳转地图应用。

API 月预算默认 200 元。当前请求预留成本是保守估算，不是供应商计费账单；必须同时设置服务商额度和账单告警。

## 数据和授权

2026-10-11 已将服务器 OSM 地点库扩展为 China、Taiwan 及日本、韩国、泰国、越南、马来西亚、新加坡、文莱和马尔代夫。共八份官方区域提取，原始 PBF 合计 **5,684,717,306 字节**；快照为 2026-10-09T20:21:04Z。服务器原始文件均通过 SHA-256 校验，使用 PostgreSQL 16.9 + PostGIS 3.5.2，保留分类、别名、坐标、原始标签和来源。

活动快照合计 **4,567,502 行**，按 OSM 对象 ID 去重后 **4,566,067 条**，数据库约 **4.33 GiB**。其中包含聚居地、站点、景点、住宿及其他设施，不能都称为旅游景点。查询测速、权限和完整备份恢复已验收，见 [TEST_REPORT.md](TEST_REPORT.md)，操作命令见 [部署说明](deploy/README.md#已部署的-osm-地点服务)。

这批数据与本机演示业务库分开。新版 `journey/2` 自动行程已从云端 OSM 城市景点聚类取候选，旧版规则行程仍使用既有示例数据。原版“地点库”检索、详情及起终点选择保留在 `/legacy.html`。同名近邻去重只是候选展示处理，不代表原始实体已合并；入口、开放/预约规则仍需逐点补齐证据。原始道路已保存，尚未构建路由引擎。本轮覆盖已提取地区，不代表全球全量或旅游事实完整覆盖。

当前本机：34,156 条导入的全球城市／聚居地索引，加 9 条编辑目的地；54 处景点示例、9 个虚拟住宿锚点。GeoNames 中中国大陆记录 2,122 条。数据库实测约 42 MB（首次测试时）。这些数量不能解释为全国景点完整覆盖。

示例景点的开放时间、票价、游玩时长、住宿位置未经逐条核验，不用于实际出行承诺。本地底图目前包括杭州、北京、成都、西安的小范围 OSM 提取；提取边界外和缺少底图的城市只显示地点与顺序，不提供离线路网导航。

详见 [THIRD_PARTY.md](THIRD_PARTY.md)，以及 [部署说明](deploy/README.md)。
## 地点库与分段路线（2026-10-11，供应商联调待配置）

从原型顶部的 **地点库** 进入 `/catalog.html`。已有服务器 OSM 查询桥接、旅行分类与住宿子类、附近检索、来源与缺失字段详情、起终点选择、名称与空间匹配、四种出行方式和换乘分段。后续产品将地点库作为后台能力；本轮未重做页面。真实高德匹配、步行和公交后端已验收，骑行、驾车、底图显示及实际导航不在本轮验证范围。

已配置地图服务后，可在地点详情点击“匹配高德地点”或“匹配境外地图地点”，核对候选名称、地址与距离，再点击“确认候选并设为起点/终点”。路线区会同时显示自有地点名和所选地图候选，可随时“改用自有地点坐标”。未确认时继续使用原始坐标；高相似评分不代表自动匹配成功，也不保证是入口。

选择只用于当前页面的路线，15 分钟内有效，绑定当前用户、自有地点和供应商；服务重启后须重新匹配。候选不写入 OSM 主库、业务地点表、文件缓存或浏览器持久存储。更改起终点、交通方式、偏好或出发时间会清除旧方案；搜索为空或失败会清除旧地点详情，已选路线端点仍在下方单独保留。

高德步行/驾车请求使用候选 GCJ-02 坐标及 POI ID；公交仅在两端都有候选时成组提交 POI ID，只有一端确认时使用该端坐标；骑行使用候选坐标。Google Routes 使用确认的 place ID。逐换乘导航继续使用各自上下车点，不误用整程候选。[高德路径规划参数](https://lbs.amap.com/api/webservice/guide/api/newroute)、[Google Routes 地点参数](https://developers.google.com/maps/documentation/routes/specify_location)、[Google Maps 跳转参数](https://developers.google.com/maps/documentation/urls/get-started)。

此前 54 项回归通过，候选按钮与参数传递另用醒目标注的合成 UI 测试验收；本次补充了真实候选及后端算路验收，未核验实地入口或真实 SDK 显示。开发者可运行 `node test/catalog-selection-ui-server.mjs` 复现离线交互测试，地址为本机 8795；该服务不使用数据库、地图凭据或外部 API，不能当作真实地图演示，检查完按 Ctrl+C 关闭。

高德申请与配置：

1. 登录 [高德开放平台控制台](https://console.amap.com/)，由账号持有人完成实名认证与协议确认。按 [创建应用和 Key](https://lbs.amap.com/api/webservice/guide/create-project/get-key) 新建 SeaTraces 应用。
2. 先申请 **Web 服务** 类型的 Key，用于服务端 POI 匹配、逆地理编码及路径规划，配置为 `AMAP_KEY`。它不是 JS Key，也不是鸿蒙 SDK Key。若启用 IP 白名单，填写实际发起请求的服务器出口 IP；本机演示时需使用本机实际出口。
3. 需要在当前 ArkWeb 原型中显示高德底图与路径时，再申请 **Web 端（JS API）** 类型的 Key 和安全密钥，分别配置 `AMAP_JS_KEY`、`AMAP_JS_SECURITY_CODE`。配置与实际使用域名相符的白名单。本实现把安全密钥保留在服务器，JS Key 属于浏览器应用标识。
4. 在项目根目录运行 `powershell -File scripts/configure-maps.ps1`，仅在本机隐藏输入框输入，留空保留已有配置。不要在聊天中发送 Key。脚本保存到被 Git 和交付打包排除的 `.env`。退出并重新运行 `start.ps1` 后生效。
5. 本机完整数据库联调需要到服务器私有地点服务的连接，`.env` 的 `OSM_SERVICE_URL=http://127.0.0.1:8791` 指向本机隧道或同机部署的服务。不要把 PostgreSQL 端口开放到公网。服务器启动方式：`python3 /home/ubuntu/seatraces-osm/scripts/osm/place_service.py`，使用现有 `reader.json`，该文件不复制到本机。
6. 配好后分别验收“外滩附近地点匹配”“步行路线”“步行→地铁/公交→步行”“少换乘备选”“地图几何显示”。申请权限、实际配额和费用以账号控制台为准；本应用 200 元预留预算并非供应商账单，也不自动购买配额。

后续替换为鸿蒙原生地图时，另申请与正式 bundleName、签名证书匹配的鸿蒙 SDK Key，参考 [高德鸿蒙公交规划文档](https://developer.amap.com/api/harmonyosnext-map3d-sdk/guide/route-plan/bus)。当前 ArkWeb 地图不使用鸿蒙原生 SDK Key。

数据部署取舍：4,567,502 条活动提取区记录（不同提取区有相同 OSM ID），库约 4.33 GiB，原始 PBF 约 5.68 GB；服务器负责完整索引、空间筛选、版本和备份。客户端只保留选中行程的自有地点数据。2 核 4 GB 服务器用于演示，不能据此承诺生产高并发或高可用。附近查询比精确名称检索更重，接口最多返回 60 条，最大半径 50 km，数据库最多并发 2 个查询、单条 4 秒超时。

地图选择：国内优先高德，理由是现有实现可复用，且官方提供多种换乘策略及鸿蒙地图/导航能力；百度也有鸿蒙地图和步骑行导航 SDK，可作替代评估。不能仅凭个人免费配额断言某厂商长期最便宜。境外地点库已经支持检索，Google 可选适配代码已补齐但真实服务未开通；当前提供地图 App 跳转。[高德路径规划](https://lbs.amap.com/api/webservice/guide/api/newroute)、[百度鸿蒙能力](https://lbsyun.baidu.com/docs/harmony?title=harmonynextsdk%2Findex)、[高德当前定价](https://lbs.amap.com/upgrade)。

商业地图结果只用于本次查询与显示，不写入自有 OSM 主库，不进行全量抓取或默认持久缓存。后续任何缓存必须以账号合同允许的范围与期限为依据，见 [高德平台协议](https://lbs.amap.com/pages/terms/) 和 [JS 安全密钥代理说明](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)。

以前的临时连接及密钥均已清理。2026-10-11 用户另行明确授权保留本机专用开发连接，现已恢复实时查询完整云端库；服务器仅允许此密钥连接 `127.0.0.1:8791`，禁止 shell/SFTP，数据库端口转发拒绝已实测。密钥保留至用户要求撤销，不放入源码包、HAP 或其他设备。当前本机运行 `start.ps1` 会同时启动或复用已授权连接；独立管理命令见部署说明。

断线时仍会显示明确标注时间的 OSM 查询缓存：最多 256 个条目、7 天，仅含已成功查询结果，不是完整数据库副本，也不随源码 ZIP 分发。未缓存查询返回连接错误。服务器 HTTP 服务仅监听 127.0.0.1:8791，由 `seatraces-osm-catalog.service` 管理，已启用开机自启并完成单服务重启验收；未重启整台服务器。此开发连接只支持本机原型及通过本机访问的模拟器，手机独立使用仍需 HTTPS 后端部署。

地点库页面可在“限定城市周边”中输入杭州、东京等城市名，选择带国家、地区和来源的城市点后检索周边；住宿子类与附近搜索中可选 3、10、30 或 50 公里。清空地点名称后可以按景点、住宿或青旅等类别浏览附近。范围按坐标距离计算，不是行政边界，也不意味着已完整收录该城市。城市候选使用已有 GeoNames/编辑索引，无商业地图请求；未覆盖的巴黎等城市会明确提示缺失。人工别名与 OSM 原始名称候选现在共同参与筛选，不再因命中补充别名而丢失其他同名结果。

新建 `osm.editorial_aliases` 与 `osm.place_facts` 保存有来源的名称及事实补录，保留原始 OSM 标签；使用 `scripts/osm/import_annotations.py` 先校验，带 `--apply` 才写入。已经录入东京塔两个中文别名及官网的营业时间、最后入场时间、网站共三条事实，营业信息限定 2026-10-11 当日；价格仍未知。示例不是全库资料补齐，也不会用“收费”标签推断具体价格。新增表备份恢复已验收，须与既有完整 OSM 备份组合恢复。

不为 456 万地点预生成两两路线（约 20.8 万亿有向组合）。先检索候选、由用户选点，再按所选交通方式请求路线；候选按耗时、换乘和步行量排序。供应商备选不能表述为数学上精确的次短路径。无 Key 时显示估算和坐标分布；本次已验证真实步行几何及公交耗时/换乘分段，底图 SDK、现场班次准确率和 GPS 导航仍待验收。

步行指引已加入沿当前路段几何计算的剩余距离、当前/下一条指令、接近终点提示及手动完成。定位精度不足、过期、跳变和偏离路线时不继续推断到达；不会自动跨过公交/地铁换乘段。路线交叉/环路采用上一位置进度消歧，复杂现场条件仍可能存在误差；没有完整道路几何时禁用位置进度。当前仅通过算法测试，实机 GPS、语音导航和从当前位置自动重规划未验收/未实现。

## 境外地图可选接入（Google，默认关闭）

国内继续使用高德；境外代码提供 Google Places API（New）地点候选、Routes API 的步行/骑行/驾车/公交路线，以及独立 Google Maps JS 地图。高德海外服务需要另外申请权限，不能假定国内 Key 和配额可直接使用；其海外公交合同、价格和实际覆盖仍需单独确认。[高德海外服务](https://developer.amap.com/api/web-service/overview)、[Google 公交换乘](https://developers.google.com/maps/documentation/routes/transit-route)。

由账号持有人完成以下配置，本轮未代为注册、接受协议、启用计费或购买配额：

1. 在 [Google Cloud 控制台](https://console.cloud.google.com/) 建立或选择项目，确认账号可用并按控制台要求启用计费。启用 Routes API、Places API（New）、Maps JavaScript API。
2. 创建服务端 Key，仅允许 Routes API / Places API（New），按实际调用位置限制出口 IP。保存为 `GOOGLE_MAPS_SERVER_KEY`。本机与上海服务器的出口不同；不要把服务端 Key 填入浏览器或鸿蒙客户端。
3. 创建独立浏览器 Key，仅允许 Maps JavaScript API，限制到实际访问来源，例如本机 `http://127.0.0.1:8787/*` 和正式部署域名。保存为 `GOOGLE_MAPS_JS_KEY`，此 Key 是浏览器应用标识，可被客户端看到；限制必须在供应商控制台生效。
4. 在项目目录执行 `powershell -File scripts/configure-maps.ps1 -Provider google`，用本机隐藏输入配置。脚本同时设置 `OVERSEAS_MAP_PROVIDER=google`。停止并重新启动应用后生效。要关闭境外请求，在 `.env` 改为 `OVERSEAS_MAP_PROVIDER=none` 后重启。不要把 Key 发到聊天。
5. 先分别检查部署服务器到 Google REST API、手机/模拟器到 Google Maps JS 的正常网络连通，再用东京塔到浅草寺验收名称匹配、步行、公共交通、少换乘、地图及逐段指引。当前上海服务器与鸿蒙端的 Google 网络可达性均未验收；不配置绕过网络限制的代理。
6. 公开上线前补齐实际运营主体的服务条款和隐私说明，并按供应商要求关联相关条款；尚未完成这些公开页面。真实许可、账号地区资格、覆盖和计费均须按最终账号确认。

`GOOGLE_REQUEST_RESERVE_CNY=0.50` 是每次后端请求的内部预算预留，和其他后端接口共享每月 200 元及每日请求数限制；它不是实际报价。Google Maps JS 浏览器地图加载不经过该预留计数，必须另外设置控制台配额与预算告警，不能保证总支出不超过 200 元。开启前按 [当前价目表](https://developers.google.com/maps/billing-and-pricing/pricing) 和 [Routes 计费说明](https://developers.google.com/maps/documentation/routes/usage-and-billing) 核对账号；未假定免费额度永久有效。

Google 响应只在本次页面内显示，不批量写入 OSM 主库或持久缓存；地图几何只送往独立 Google 地图框架，不叠加到高德或 OSM 底图。候选显示 Google Maps 署名、供应商返回的第三方署名及链接，路线保留警告、公交站名和运营方链接。[Routes 使用政策](https://developers.google.com/maps/documentation/routes/policies)、[Places 使用政策](https://developers.google.com/maps/documentation/places/web-service/policies)。

公交出发时间按起点的 IANA 时区转换为 UTC：已收录的亚洲区域可自动填入，用户可以修改；多时区国家不凭国家名猜测。夏令时重复或不存在的当地时间会被拒绝，请改选明确时刻。Google 公交请求限制在过去 7 天至未来 100 天，返回班次仍可能调整。候选按耗时/换乘数排序，不宣称证明数学上的最短或次短路径；未得到道路几何时禁用位置进度。11 项境外解析测试为人工构造的契约样本，真实 Google 请求、账单、SDK 渲染和鸿蒙导航尚未验收。

## 按到访日期查看开放时段（2026-10-11）

地点库详情新增“查看某天开放时段”：选择地点当地日期，解析已有 OSM `opening_hours` 的工作日、午间休息、闭馆例外、季节和跨午夜规则；保留原始规则、来源快照及补充来源说明。它是资料解释，不是实时营业确认；日期变化后会清除旧结果并要求重新查询。住宿、餐饮、休息处等显示各自常用资料的已记录数量和缺失项，有记录不等于已核实。

`GET /api/catalog/opening?id=osm:way/173154847&date=2026-10-12` 按需读取已授权只读云端服务，使用锁定的 `opening_hours@3.15.0` 在服务器本地解析，不产生商业 API 请求。日历计算使用隔离 UTC 进程表示地点当地钟面；返回时段不是 UTC 时刻，不用于计算实际乘车或游玩持续时间。最多两个解析进程、每次 2.5 秒超时、输入 2,000 字符上限，避免原始规则阻塞服务。

节假日/学校假期/天文时刻所需的当地资料尚未核验，相关表达式明确返回 `needs_context`。未收录、语法错误、预约或不确定结束时间分别保留缺失/不可解析/不确定状态；不采用解析器猜测的结束时间，也不把缺失数据当全天开放。人工补充的时限说明和 OSM 规则并列展示，不自动把仅适用于某日或某区域的信息推广到整个景点。最后入园、门票、预约规则和实地开放仍需补充核验；此功能尚未接入自动行程排程器。

从旧源码目录升级时请先运行 `npm ci` 安装锁定依赖，再重启原型。解析库来源与许可见 THIRD_PARTY.md；7 项真实云端接口检查和 45 项本机回归结果见 TEST_REPORT.md。

## 景区合并与“想去”优先（2026-10-11，当前规则）

城市片区使用 `city-areas/3`：按合并后的候选量与实际空间分布自适应二分，大城市通常 8～12 片，最多 12 片；小城更少，同坐标不强行拆片。不因片区数减少而抽掉候选。`inventory` 分别报告片区数、可选地点数、子景点数与原始记录数；列表分批展开只影响显示，不影响保存的数据。这里保留的是已取回且符合可游玩条件的候选；2026-10-12 起，城市读取会对达到单次 8,000 条返回上限的范围继续细分查询并去重，不再把首批返回当作全城候选。这仍不表示 OSM 已覆盖现实中的所有景点。

`server/domain/scenic-entities.mjs` 负责去重与景区层次，`scenic-clusters.mjs` 负责地理分组及评分。依据可信名称/别名、限定距离与 Wikidata 关联合并重复表示；纯数字别名、泛称、不同院区不能作为同一景点的证明。明确父级关系或“景区名—子景点”的名称关联可组成 `children`。保留 `sourceRecords`、`possibleDuplicateIds`、`sourceRecordCount`，不删除 OSM 主库记录，也不把单纯邻近等同于从属。没有边界/从属依据的园内景点暂时仍分开，不保证所有景区都已合并完整。重复记录不重复加分，独立子景点贡献一次分数。

前端景点按钮改为“想去”，不再让用户逐个填写去没去过。`user_place_wishes` 独立保存到账号；`POST /api/journey/sessions/:id/wishes` 校验问卷归属和候选范围。同一地点的重复 ID 同步更新；子景点想去会提升所属景区，选择想去时自动选中其片区。新问卷恢复已保存偏好及对应片区，用户仍可取消片区。

规划从选中片区保留全部意愿点，另取最多 60 个普通候选；这一步不缩减城市展示资料。每次模型输入最多 60 个地点，后续日期批次继续从未安排候选中取点。传入 `wanted`、景区子景点、到访来源和已有资料；模型只能返回内部候选。明确“想去”优先于“探索新地方”，补位规则保留模型的后续日期安排，遗漏意愿点按剩余天数分配，并继续检查开放时间、通勤估计、停留时长及每日容量。`plan.wishes` 返回意愿数、已安排数及未安排原因；前端可展开查看，避免静默丢弃。

自动到访通过“记录到访”按钮启用，仅在旅行当天、页面前台且获得定位权限后采样。后台校验至少 10 分钟的连续观测、精度、间隔和距离；经过、漂移或多个地点无法区分时不记录。只保存 `user_place_presence` 的地点、时间和停留时长，不保存定位轨迹。其来源为 `location_dwell`、状态为 `inferred`，不会当成确认游玩并硬性排除；OSM 代表点也不是已核验入口。页面隐藏会清空这段采样，恢复后重新累计；刷新默认暂停。原生定位桥接新增只读已有授权的接口，不在被动采样时重新请求权限。模拟器 GPS 排查已按用户要求停止，真机效果待验收。

验收：已有北京、杭州、苏州候选分别形成 12、12、8 片，原始 ID 无丢失；杭州真实新问卷返回 2,321 条原始记录、2,305 处合并后地点和 2 个子景点。针对性领域测试及隔离数据库归属检查通过。新版 HAP 已构建并更新到 Pura 90。数据与界面记录见 `validation/scenic-wishes-catalog-20261011.json`、`validation/scenic-wishes-api-20261011.json`、`validation/scenic-wishes-ui-20261011.json`。

真实浏览器复验（11 月 14～15 日杭州示例）：勾选雷峰塔和孤山公园内的鲁迅铜像，两处意愿均纳入；第一天雷峰塔→孤山公园，第二天杭州西湖文化景观→中国丝绸博物馆。第一天高德路线已显示，刷新恢复及新问卷偏好恢复均已核对。额外回归验证模型已安排在后一天的意愿点不会被补位逻辑抢到第一天。第二天的真实路段未在本轮额外调用验收；此例也不代表已获得西湖整体与各子景点的完整边界关系。

### 地点列表与评分口径

地点名称旁不展示去重提示。片区内景点、景区内子景点均按 `score.total` 从高到低显示，同分按地点 ID 保持稳定顺序，先排序再分批展示。片区本身按分数总和降序。评分权重未因这次显示调整而改变，“想去”独立影响行程调度，不加进列表评分。

单地点分数为：基础 20 + 知名度/资料代理分 + 信息字段分 + 兴趣匹配分 − 重游惩罚 − 拥挤惩罚，最低 0，保留一位小数，不是百分制。

| 项目 | 现行规则 |
| --- | --- |
| 知名度 | 有未过期、有来源的 0～1 知名度信号时，加 `30 × 信号值`；没有时，改用 OSM 的 Wikipedia 标签 +8、Wikidata 标签 +4、heritage 标签 +10，可叠加，最高 22 |
| 信息字段 | 开放时间、网站字段各 +4，最高 +8；仅检查字段存在，不代表内容已核验或仍有效 |
| 兴趣 | 每命中一个兴趣标签 +5 |
| 重游 | 已记录到访且偏好“探索新地方”时 −12；位置停留推断仍带来源，不是确认入园记录 |
| 拥挤 | 有未过期、有来源的 0～1 客流信号才扣分：避拥挤 `25 × 信号值`、均衡 `12 × 信号值`、接受热闹 `3 × 信号值`；缺失不扣分，不等于不拥挤 |

景区展示总分为自身分数加各独立子景点分数；重复记录不重复计分。片区分数为各景区/独立景点分数相加。因此，子景点多、资料较完整的景区或片区容易靠前，不能把这个分数理解为真实游客口碑或实际人气。2026-10-11 本机 `place_signals` 查询为空，当前尚无真实知名度与客流信号参与评分。片区页使用当时的已保存旅行偏好；后续问卷答案在生成行程时使用，不回溯刷新已浏览片区的分数。

## 模拟器反馈修复（2026-10-11，早期记录；片区数以上节为准）

城市候选片区改用确定性的地理二分聚类，目标为每城 5～8 片；不足 5 个可游玩点时按实际数量显示。北京 5,219 个候选原先形成 1,437 个小聚类，现在为 8 片；合并近距离的“故宫/故宫博物院”双重表示后为 5,218 个游玩候选，保留被合并的 OSM ID 和别名。杭州为 7 片，苏州为 5 片。这是城市选区粒度，不代表一天需要游完一个片区。每城从已选片区交替取最多 60 个高分候选送模型，评分仍为景点分数之和。

地图和卡片显示相同的独立编号 1～8，展开后分批显示景点。圆点位于该片区的代表景点，不再把平均坐标或为避让移动后的坐标冠以景点名称。OSM 主库保持 WGS84；中国大陆高德显示前转换为 GCJ02。一次真实高德复核中，人民英雄纪念碑偏差约 5 米，故宫博物院约 111 米；这验证了大致位置，不等于确认导航入口。比对记录见 `validation/feedback-coordinates-20261011.json`。

内部每日限额不再默认让地图和模型共同挤占 100 次：默认高德 300 次、DeepSeek 50 次、Google 30 次，总上限 400 次，均可通过 `.env` 调整。每日按北京时间计算；月度仍保留 200 元请求预留上限。预留金额不是厂商真实账单，也不含浏览器底图加载的计费。错误会明确区分本程序日限额与月预算。成功获取的城市边界仅在进程内复用 6 小时，失败结果 20 分钟；重启后需要重新请求。

修复补充详情时丢失聚类派生别名的问题，使“故宫”可利用“故宫博物院”别名匹配供应商候选。120 米内、仅相差“博物院/博物馆”后缀的同名景点作为一次游玩；午门、异地北院区等仍分开。去重只影响候选和行程，不删除 OSM 记录。真实请求验收见 `validation/feedback-flow-20261011.json`：北京两日行程已保存，两天高德路线均返回 live，共分别 3、5 个路段。16 项针对性测试通过：`node --test test/journey.test.mjs test/journey-feedback.test.mjs`。

地图安全代理改为一级路径 `/_AMapService`，保留旧路径兼容，安全密钥仍仅留在后端；对应[高德官方代理配置说明](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)。鸿蒙外壳保持同步渲染，增加限定后端来源的原生 LocationKit 桥接及权限、定位开关、无信号分类提示。新 HAP 已构建、安装，地图画面已确认；模拟器未拿到位置，按用户要求停止 GPS 排查，留待真机验证。真实定位成功尚未验收。

后续浏览器验收还确认并修复了高德 V5 的几何解析兼容问题：实际响应可能将坐标串放在 `polyline.polyline`，旧解析只处理直接字符串，导致文字有路线而地图无折线。现在步行、公交等分段同时支持两种返回结构，保留高德显示坐标和 WGS84 导航坐标的区别。相关聚类、接口预算、路线及导航测试合计 31 项通过。通过正常界面新建北京两日示例，已确认问卷提交、持久化、刷新恢复及实际道路折线显示；未覆盖旧行程。最新浏览器截图为 `screenshots/beijing-eight-clusters-20261011.jpg`、`screenshots/beijing-feedback-trip-20261011.jpg` 和 `screenshots/beijing-feedback-transit-20261011.jpg`。

## 统一卡通版与按时间选点（2026-10-11）

正式客户端入口统一为 `/`，未登录进入 `/login.html`。旧 `legacy.html` 和 `catalog.html` 重定向到首页；2026-10-12 已删除此前归档在 `archive/legacy-ui/` 的旧页面、专用脚本和样式。地点查询仍作为后台接口提供。账号管理和历史行程从卡通版“我的”打开；旧格式行程可在历史中只读查看，已有账号、行程和社区数据没有删除。发现、收藏、历史浏览及旅行报告目前为卡通 UI 空壳，旧后台接口保留。鸿蒙外壳加载同一个卡通版页面。

景点结构已经贯穿城市选片、评分、想去偏好、模型输入和持久化行程：`城市 → clusters 片区 → members 景区/独立景点 → children 子景点`。片区是地理分组，不等于官方景区。景点包含 ID/名称/别名、分类/标签、经纬度及坐标角色、地区/时区、开放规则、来源及时间；派生层另有 `entityType`、`children`、`sourceRecords`、`score`、`wanted`、`visitHistory`。按需补充的 `facts` 包含字段值、来源链接、检查时间与有效状态，并非每个景点都齐全。

云端 `osm.poi` 保存原始地点及标签，`osm.place_facts` 保存带证据的补充资料，`osm.editorial_aliases` 保存编辑别名。景区归属保存在 `journey_sessions.catalog` JSONB，选中景区及子景点再进入 `trips.plan` JSONB；2026-10-12 起另增应用 PostgreSQL 表 `scenic_parent_checks` 保存高德归属查询结果，详见下节。尚未建成覆盖全国的官方景区父子关系主表，也未接入景区面边界来判定包含关系。以下是 2026-10-11 的旧规则核验：杭州 2,305 处可选地点仅识别出 2 个子景点，上海 1,787 处仅识别出 1 个；“孤山公园 → 孤山公园-鲁迅铜像”已经实际保存，依据是名称关联，不能当作官方核验。完整字段和实例见 `validation/cartoon-structure-20261011.json`。

新行程采用 `server/domain/day-budget.mjs` 的 `time-budget/1`，取消按节奏固定 2/3/4 处和跨城日下午最多 2 处。数量由 `总游览分钟 + 相邻交通分钟 + 衔接/用餐分钟 + 等待开放分钟 ≤ 当日预算` 决定。轻松/适中/充实分别为 09:00–17:00/18:00/19:00，跨城日从 14:00 开始；衔接时间分别为 12/8/5 分钟，整日行程午间预留一次 45 分钟。已知闭馆或时窗不够的地点不能硬塞进日程，“想去”未排入的地点仍有清单。

停留时间优先采用有来源且未过期的 `stayMinutes`；缺失时使用公开标记为规划预留的类型规则，例如艺术小品 20 分钟、观景点 25 分钟、公园 60 分钟、博物馆 120 分钟，未知类型 90 分钟。交通初估使用直线距离 d（公里）：短距离步行约 `max(3, ceil(1.3*d/4*60))` 分钟；较远或少步行偏好约 `ceil(12 + 1.3*d/18*60)` 分钟。这些系数是可调整规则，未用实际游览样本拟合；高德返回后按真实路线耗时重新计算日程时间，超过预算会提示。模型只做候选选择，后台负责时间校验；单次最多 60 个候选是输入规模保护，不是每日固定景点数量。旧行程不会自动重排，新规则在新生成的行程生效。

首页打开/恢复行程和切换日期时自动请求当前当天路线，相同请求合并，后端已有 15 分钟进程缓存。绿色线保留高德道路几何并使用圆角；缺失路段以灰色虚线曲线连接相邻景点，仅表达先后顺序，图例明确标注“连线示意”，不用于导航。道路几何齐全后对应示意线撤下。

针对性验证：`node --test test/time-budget.test.mjs test/journey.test.mjs test/scenic-wishes.test.mjs`，24 项通过，包含 10 个邻近短停留点、远距离/长停留对照、跨城日下午、过期资料、开放约束、意愿保留和路线校准。10 点案例是人工构造的算法验证，不是实际游览保证。旧入口跳转、旧脚本下线及服务健康见 `validation/cartoon-delivery-20261011.json`。

五景点真实验收暴露高德 `10021` 每秒请求限制后，后端高德适配器改为共享队列，相邻请求开始时间至少间隔 1.2 秒，不自动重试计费请求、不提高日配额。错误文案区分瞬时频率限制和总预算；额外 12 项接口边界及排队验证通过。此队列只约束本进程的 Web 服务请求，不能约束同账号其他程序的并发。`10021` 含义见[高德错误码说明](https://lbs.amap.com/api/webservice/guide/tools/info/)。

正常界面已用 DeepSeek 新建并保存 11 月 14 日杭州一天示例：雷峰塔、孤山公园、文澜阁、浙江省博物馆、柳浪闻莺，共 5 处；2/2 个“想去”地点保留，孤山公园的子景点仍在行程中。草稿 09:00–17:19，当前停留时长均为类型预留。保存后的时间预算、地点、子景点与来源见 `validation/cartoon-trip-20261011.json`；没有覆盖任何旧行程。

该示例刷新恢复成功，雷峰塔到孤山公园返回真实步行/公交分段（约 34 分钟）。其余三个地点的高德入口匹配尚未通过现有阈值，对应路段显示灰色曲线，不声称完整导航验收通过；下一步可针对这三个地点核对院区、名称和入口资料。地图将临近标签分行并以细线指向原坐标，避免示例中的孤山公园、文澜阁、浙江省博物馆名称互相遮住。

## 高德父子归属与五城批处理（2026-10-12）

**当前策略已改为下面的低成本离线流程。** 高德全量父级批次保持暂停，Web 后台自动查父级默认关闭；地图显示和用户请求的路线接口仍按需工作。不要为恢复地点整理而重新启动旧的 `run-five-city-parents.mjs --run`。

按用户最新要求，城市聚类先读取高德父子归属：成功匹配且 `parent` 为空的地点作为一级地点，有 `parent` 的地点追溯到最上层，作为二级地点放进 `children`。同一父景点只保留一次，归属在城市空间分组之前处理，避免父子被拆到不同片区。父景点缺失时先匹配现有 OSM 数据，仍缺失时增加独立的高德父级容器，不写入 `osm.poi`；此容器自身不增加资料基础分。查询失败、无匹配、匹配有歧义、父级字段未返回、关系循环分别保留待核对状态，不能解释为“没有父级”。父级营业资料不会自动复制给子景点。

职责：`server/integrations/amap.mjs` 负责限速和供应商请求；`server/services/scenic-parents.mjs` 负责地点匹配、父级补查、断点及后台队列；`server/domain/amap-parent.mjs` 负责身份匹配和结构覆盖；`server/repositories/scenic-parents.mjs` 将精简归属结果、来源 ID、时间和输入摘要写入当前应用 PostgreSQL 的 `scenic_parent_checks`。它与云端 OSM 主库分离，目前部署在本机原型数据库。成功归属复用 14 天、无匹配等复用 1 天、网络失败复用 10 分钟。CLI 与 Web 后台通过 PostgreSQL 锁避免重复处理；新问卷读取最新结果，既有行程保留原快照。

## 服务器全类别 OSM site 层级重建（2026-10-12，已部署并验收）

本轮按 `type=site` 的明确成员关系处理全部活跃数据区域，保留现有 11 类及子分类。relation 本身作为父容器；成员可以是景点、餐饮、住宿、交通、购物、休息处、服务、聚落等任意类别，支持嵌套 site 和多个父级。父容器即使未进入原 POI 索引，也会作为来源对象补进层级表。原始 `osm.poi`、来源标签及已复核资料保持原状。

`site_hierarchy.py` 解释成员角色并检测环；`rebuild_sites.py` 在服务器校验所有活跃原始 PBF、提取关系和引用对象、匹配现有地点、备份旧层级、事务写入并切换版本；`site_schema.sql` 提供关系表和保留所有原地点的 `osm.current_poi_hierarchy` 视图。`perimeter`、`outer`、`inner`、`label`、`admin_centre` 角色保留在 `site_members`，不转换成普通子地点。`multipolygon`、行政边界、距离接近和模型猜测均不用于本轮 site 归属。多父级全部保留，循环边隔离，有关地点不会被强行选一个父级。未发现成员关系仅表示 `no_site_membership_recorded`。

发布后的数据由 `site_catalog.py` 提供 `/site?id=...&category=food&limit=50`、`/site-coverage`；前者返回父级和直接子项，可继续查询子 site，使用 `nextCursor` 翻页，没有 `hasMore`。普通地点响应附带 `siteHierarchy.parentIds`、`childCount`、`childrenByCategory`。地点原类别保持不变；关系来源是 OSM，不代表门票、开放时间、管理主体和入口相同。`install_site_reader.py` 在批次成功后备份并增量接入现有只读服务，失败恢复旧服务文件。

本机业务后端已接入 `GET /api/catalog/site-coverage` 和 `GET /api/catalog/site?id=...`；后者支持 `category`、`limit`（1–200）及 `after`。例如 `http://127.0.0.1:8787/api/catalog/site?id=osm:relation/19614387` 返回“西湖十景”及南屏晚钟、柳浪闻莺、断桥残雪等 10 个成员。`osm:relation/12122761`（北京丰台体育中心）下的 `osm:relation/12122760`（丰台体育中心垒球场）也是 site，可继续向下查询。site 层级表示明确的 OSM 成员关系，不能直接将其展示为已经核验的“地理位置在景区内”。

本批服务器实测结果：

| 项目 | 数量 |
| --- | ---: |
| 活跃原始数据文件 | 8 |
| 原库导入记录 / 唯一地点 | 4,567,502 / 4,566,067 |
| site 父容器 | 3,368 |
| 原始成员记录 / 技术角色成员 | 85,728 / 986 |
| 去重后有效成员关系 | 84,670 |
| 原地点中具有 site 父级的地点 | 10,172 |
| 嵌套 site 关系 / 多父级对象 | 123 / 381 |
| 类别变化 / 循环关系 | 0 / 0 |

所有 11 类都有成员关系：景点 708、历史文化 2,950、自然 135、休闲 757、住宿 37、餐饮 369、休息设施 121、交通 3,712、购物 467、聚落 1,210、服务 12,315。另有 61,889 条关系指向无法按现有规则分类的原始对象，统计中记为 `unclassified`，并没有新增产品类别或把它们提升为可游玩景点。427 个引用对象未在这些原始文件中找到，保留引用和缺失状态。原始 POI、已复核资料不删除。

首轮全量处理约 438 秒；增大查询批次后，复用解析缓存的第二轮约 121 秒。11 类单点接口实测约 92–352 ms（服务器本机，非并发压测）；本机后端经既有 SSH 隧道查询层级约 383–442 ms。数据库版本指针和新增表的统计信息已更新。来源只有 OSM 明确记录的 site 成员，因此全量扫描完成不等于全国所有景区的 parent/children 都已补齐。

服务器执行（部署文件到独立批次目录后）：

```bash
python3 /home/ubuntu/seatraces-osm/batches/site-hierarchy-20261012/start_site_rebuild.py
# 查看一次状态（启动器会顺序完成重建和查询接口接入）
python3 /home/ubuntu/seatraces-osm/batches/site-hierarchy-20261012/rebuild_sites.py
```

原始数据哈希和代码共同确定版本；重复执行复用提取检查点。旧批次不删除，发布只切换 `osm.site_active`；备份目录包含恢复旧指针的 `rollback.sql`。后台单次运行后退出，不创建循环调度，不调用高德或 DeepSeek，不新增数据库公网端口。解析依赖隔离在服务器 `.deps-site`，原查询服务依赖不变。

已通过 8 项规则/原始 OSM 解析检查、PostgreSQL 表结构验证、全量行数及分类一致性核对、11 类地点接口抽查和本机后端层级查询验收。当前版本为 `b60d110d6b111f3992e0d788d70467ec12c86f14d1acaf36f33e1e9e5809a927`；服务器回执保存在 `audits/site-hierarchy/{receipt,reader-receipt,acceptance}.json`，本机留存 `validation/site-hierarchy-server-20261012.json` 和 `validation/site-hierarchy-backend-20261012.json`。本批临时 SSH 公钥已于北京时间 2026-10-12 19:39:40 移除，并验证无法再次登录；既有只读隧道保留。

## 可重复执行的低成本归属流程（2026-10-12）

```powershell
# 后台执行一轮：OSM → 规则 → 已登记官网 → DeepSeek 提取 → 保存后自动退出
./scripts/start-scenic-hierarchy.ps1
# 完全离线，只运行 OSM 和规则
./scripts/start-scenic-hierarchy.ps1 -OfflineOnly
# 查询一次进度/阶段 ETA；无需持续监视
node scripts/run-scenic-hierarchy.mjs --status
# 写停止标记，下个计费请求前检查；再次启动自动断点续跑
node scripts/run-scenic-hierarchy.mjs --stop
```

脚本每次跑一个完整周期并退出，不创建定时任务，不无限重试。前提为本机 PostgreSQL 已启动，五城快照与已校验中国 PBF 存在，Python 可使用 osmium 4.3.1、Shapely 2.1.2。当前启动器复用现有 Python 和 `.runtime/osm-deps`，也可通过 `OSM_PYTHON` 指定解释器。数据不变时复用扫描结果和模型响应；新增官网后再次执行会补做新的证据任务。

算法职责：

1. `scripts/osm/scenic_geometry.py` 对现有 PBF 依次扫描关系、线、节点；只保留五城目标及轮廓必需的引用。C++ ID 过滤在 Python 回调之前执行，避免遍历无关节点。每阶段写检查点，验证原始 SHA-256，不调用地图接口。
2. Shapely STRtree 做完整几何包含判断，保留多边形空洞，区分行政边界与历史景区边界。缺失轮廓的面对象不以代表点推断归属。`site` 成员与 `is_in:tourism` 等明确关系可作为来源支持；单纯包含只产生 `spatial_candidate`，不自动合并；循环、矛盾留待核对。没有候选保留 `unknown`，不声称已证明独立。
3. `server/services/hierarchy-evidence.mjs` 只抓取 `data/editorial/hierarchy-sources.json` 登记的官方页面。同页一次抓取、24 小时复用，给模型传相关片段。仅有 OSM 网站标签的地址列入来源发现清单，不自动当作官网。没有证据的候选不调用模型。
4. `server/domain/scenic-hierarchy.mjs` 校验 ID 白名单、原文引用和字段范围。LLM 只生成待复核建议，字面引用存在不等于语义正确。接受或拒绝的语义复核写在 `hierarchy-reviews.json`，锁定任务摘要与网页哈希；源码/证据变化后不能沿用原批准。开放时间等额外字段不会自动继承或覆盖已核对事实。
5. `scripts/run-scenic-hierarchy.mjs` 管理单工作进程锁、原结果备份、分批入库、模型费用预留、断点与阶段 ETA。模型请求发出前保存 attempting 状态；中断/失败不自动重新计费，需检查后处理。相同内容与模型版本重跑不重复付费。

结果写入当前本机应用 PostgreSQL：`scenic_area_geometries` 保存 WGS84 GeoJSON 轮廓；`scenic_hierarchy_results` 保存方法、候选、来源摘要、时间、待核对提案和确认关系。未改写云端 `osm.poi`，也未覆盖 `scenic_parent_checks`。读取时先保留现有高德结果和已核对资料，仅补充有依据的关系。新问卷读取新数据，历史行程不变。

运行文件位于 `.runtime/scenic-hierarchy/`：`status.json` 给出阶段/耗时/预计完成时间，`geometry-result.json` 保存离线数据，`jobs/` 保存模型检查点，`source-discovery.json` 保存待核对网站。汇总与 100 条分层样本在 `validation/scenic-hierarchy-latest.json` 和 `validation/scenic-hierarchy-sample.json`。样本清单不等于已测得准确率。

`HIERARCHY_MODEL_BUDGET_CNY` 默认 5 元/同一原始数据批次，跨重跑累计；同时受现有模型日限额和每月 200 元预留约束。该流程高德调用为零。`reservedCny` 是保守预留，`estimatedCny` 根据实际 token 按高峰未命中缓存单价估算，均不是厂商账单。来源未登记、官网不可抓取、名字不匹配、无归属证据等会保留待处理，`complete_with_unresolved` 表示本轮执行结束，并不表示全部景点的父子关系都已确认。

本轮取消父级批处理的每日/每批总数量上限，继续执行供应商限速和原定每月 200 元预算。`AmapParent` 请求单独记账、计入总金额，不挤占交互功能的本程序每日次数；每次按 0.003 元预留，依据 [2026-10-12 核对的高德基础搜索公开价格](https://lbs.amap.com/upgrade) 30 元/万次。这是预算估计，免费额度、账号配额及实际账单以高德账户为准；旧的预算预留记录未改写。

`node scripts/run-five-city-parents.mjs --run` 持续轮换北京、上海、广州、深圳、杭州，100 次为保存进度及切换城市的工作块，不是总数量上限。每条查询结果立即落库。再次运行从已保存结果继续；遇到供应商额度、月预算或服务故障会写明暂停原因。`--prepare` 仅准备清单，`--status` 读取 `.runtime/five-city-parents/status.json`。2026-10-12 首次完整候选为北京 6,905、上海 1,869、广州 1,514、深圳 1,894、杭州 2,321，总计 14,503 条；这是当前 OSM 库和可游玩筛选规则下的候选，不保证覆盖现实中的所有景点。分块读取消除了单次 8,000 条返回导致的城市截断，边界处记录按 ID 去重。深圳通过已验证城市边界排除港澳后可正常进入高德查询。

故宫试点 9 条原始记录去重后用 8 次真实查询，得到故宫的 5 个子景点（太和殿、中和殿、保和殿、乾清宫、御花园），景山公园、北海公园保持一级。五城任务目前已启动，尚未全量完成；各城最新统计及父子实例写入 `validation/amap-parent-<cityId>.json`。测试覆盖空父级与失败区分、跨候选父级、多层展开、重复调用复用、循环、预算、分块读取及深圳边界判断。

批处理需要本机 PostgreSQL 持续运行，执行期间请保持电脑开机，避免重启 `scripts/local.mjs`（该启动器同时管理内嵌 PostgreSQL）。断电或数据库中断不会清除已写入结果；数据库恢复后重新运行 `--run` 可继续。`node scripts/check-five-city-parents.mjs` 只读已保存结果，检查五城原始地点 ID 是否保留、父子层级是否一致，并输出 `validation/five-city-parents-readback.json`，不会调用高德。进度中的 `pending` 是尚未查询，`unresolved` 是已查询但未能可靠确认归属；两者均不能宣称已完成归属。

### 五城剩余地点的 DeepSeek 判断

2026-10-12 前端已接入模型辅助归组：只选取通过结构校验、输入与轮廓版本一致、父子均存在于当前城市、且非边界接触的 OSM 轮廓包含建议。已确认高德/官方关系优先，循环及冲突不合并。仅凭邻近位置、名称推测的建议继续保持原展示。模型原始结果仍为 `unverified_model_assessment`，显示层派生 `parentRelation.status=model_suggested`，不将模型输出改写成官方确认。

前端沿用“片区 → 景区 → 景点”；涉及模型建议的列表标题为“一起逛”，子项带“建议”标记，保留得分排序与“想去”。多层关系展开到顶层时，只要路径经过模型建议，最终展示也会保留待核实标记。不复制父景区开放时间、门票或入口到子景点。新问卷采用新分组；已经保存的行程仍保留当时的快照。设置 `SCENIC_MODEL_GROUPING_ENABLED=false` 并重启后端可以关闭模型归组。

五城真实数据只读验收保留全部 14,503 个原始地点 ID。2,811 条模型归属建议中有 2,564 条具备轮廓包含候选；经过当前有效版本、优先级和去重等处理，最终展示 2,428 个带建议标记的子景点。五城当前片区数分别为北京 12、上海 11、广州 10、深圳 11、杭州 12。结果见 `validation/scenic-hierarchy-readback.json`；这是完整性验收，不是归属准确率证明。

`scripts/assess-five-city-deepseek.mjs` 对仍待确认的地点逐条生成模型判断，每组最多 10 个地点，五城轮换。先用已有景区轮廓包含候选，再补充同城 3 公里内的博物馆、园区等候选；只允许引用实际存在的地点 ID。输入包括名称、别名、分类、坐标、距离、包含关系及已登记官网的相关片段。模型不自行联网，不能补写输入以外的地点、URL 或营业事实。附近关系和几何包含只用于判断候选，不能证明票务或管理归属。

结果分为 `child_candidate`（建议归属）、`independent_candidate`（可能独立）、`unknown`（证据不足）。全部带有 `requiresReview: true`，保存在本机应用 PostgreSQL 的 `scenic_hierarchy_results.result.modelAssessment`，包含模型、输入摘要、理由、引用和时间。不会改写已确认父子关系，也不会自动改变前端景区分组。规则流程重跑时仅在原始数据摘要相同时保留该判断。引用逐字校验通过也仍需核对其语义，不能把模型处理完成当成归属确认完成。

```powershell
# 仅准备清单，不付费
node scripts/assess-five-city-deepseek.mjs --prepare
# 先试跑最多 5 个未处理任务
node scripts/assess-five-city-deepseek.mjs --pilot
# 后台跑完当前清单后自动退出；相同输入复用已保存响应
./scripts/start-deepseek-hierarchy.ps1
# 按需查看进度，或请求在下一次调用前停止
node scripts/assess-five-city-deepseek.mjs --status
node scripts/assess-five-city-deepseek.mjs --stop
```

本批默认 20 元预算，另受全局每月 200 元预算限制。批次计费请求与交互功能的每日次数分开，金额统一记入 `api_usage`。每次调用前按输入字节和最大输出估算上界并预留，收到 token 用量后按 DeepSeek Flash 高峰未命中缓存价格保守估算；缺少用量就保留预留金额。这不是厂商账单。错误、超时和断线任务不自动重复付费；连续 3 次失败或校验拒绝会暂停。电脑和本机 PostgreSQL 须保持运行。无定时任务，无持续轮询监控。

断点位于 `.runtime/deepseek-hierarchy/jobs/`，输入清单在 `inputs.json`，进度和按实际吞吐推算的 ETA 在 `status.json`。本轮结束后输出 `validation/deepseek-hierarchy-latest.json`。`complete_with_failed_jobs` 表示清单遍历结束但有失败，`complete` 也仅表示完成模型判断，并不意味着所有地点均获官方确认。

### 前一批官方证据补充状态

本批从故宫博物院官网获取资料，再通过已配置的 DeepSeek 接口实际调用 4 次，累计 17,563 tokens。模型结果经引用与适用范围复核后，得到 5 条父子关系（太和殿、中和殿、保和殿、乾清宫、御花园属于故宫）和 9 条补充资料，保存在 `data/editorial/palace-20261012.json`；原始模型结果、抓取时间及页面快照在本机 `.runtime/palace-evidence-20261012/`，复核修改记录见 `validation/palace-enrichment-20261012.json`。军机处因当前候选库没有对应地点 ID，保留待补录；未编造坐标。官网同页包含历史内容，需按当前有效章节核对；抓取日期不等于资料发布日期，也不保证覆盖全部临时闭馆公告。

本机分组预览通过 7 项核对，保留全部 98 条原始来源记录；景山公园、北海公园仍独立，子景点不自动继承父景区开放时间。相关既有领域测试 10 项通过。准备了 `scripts/osm/scenic_enrichment.sql`、事务导入与备份脚本 `apply_scenic_batch.py`、服务部署和读回脚本 `deploy_palace_batch.py`，拟新增独立的关系与批次记录，不覆盖 OSM 原始地点。腾讯云已登录，但终端控制工具超时，尚未执行数据库写入，不能把本机预览当成云端验收。待实际部署后运行 `node scripts/check-palace-enrichment.mjs --live` 并更新本节状态。

另做了两次高德 V5 POI 查询：太和殿返回的 `parent` 指向故宫博物院；本次两组响应均未返回景区面边界，请求 `children` 也未得到完整子景点列表。这是历史供应商查询记录；新的产品父级规则见下节。地点检索索引仍使用代表点，行政区边界、商圈字段、中心点或外接矩形均不能替代景区边界。[高德 POI 字段说明](https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch)、[行政区域查询说明](https://lbs.amap.com/api/webservice/guide/api/district)。

### 全库完整包含父级，最多 8 层（2026-10-13，全量已发布，接口已读回）

用户指定的产品规则：一个地点的完整几何被另一个景点的区域覆盖，就作为其子地点；直接父级取面积最小的包含景点，面积相同时按 OSM ID 稳定选择。最外层为第 1 层，最多 8 层。自然层级超过 8 层的地点统一挂到其第 7 层祖先下，同时保存原直接父级和原深度，不删除地点。

- 范围：全部活动地区数据包对应的既有地点，不限五个城市。原 11 类不变；四种既有景点类别 `attraction/heritage/nature/leisure` 的有效面可作为父景点，其他类别也可作为子项。行政区边界不作景区父级。
- 几何：从既有 PBF 恢复完整 way / relation 轮廓，保留洞，统一 WGS84；使用 `ST_Covers`，允许贴边但不允许任何部分越界。相同面不互为父级。真实节点按映射点判断；面对象缺少轮廓时不使用代表点冒充完整面，返回 `geometry_unavailable`。跨日界线的复杂轮廓暂记待核对。
- 层级性质：`located_in`、`rule_derived`，表示产品采用的几何包含规则，不自动继承开放时间、门票、经营归属。原 site 成员关系和官网证据保留在独立字段。
- 发布：新建版本化 `containment_*` 表；校验包含关系、无环、层数、分类不变后原子切换活动版本。原 `osm.poi` 不覆盖。旧版本保留，发布前记录旧指针和 `rollback.sql`。失败时不发布草稿。
- 重跑：相同代码和数据已完成时直接复用；PBF 几何抽取结果按来源哈希缓存。失败草稿可重建。每个地区通过独立低优先级进程处理，释放节点索引内存；无地图/LLM 调用，无定时任务，无新增登录凭据。

入口为 `scripts/osm/rebuild_containment.py --run`；`start_containment_rebuild.py` 在服务器后台依次完成重建、只读服务更新和验收。`validation/containment-hierarchy-package/run-on-server.txt` 包含校验哈希的完整传输与启动命令，只能在既有服务器终端执行。状态位于 `/home/ubuntu/seatraces-osm/audits/containment-hierarchy/` 的 `status.json`、`batch-status.json`、`receipt.json` 和 `reader-receipt.json`；仅 `batch-status=complete` 且读回回执存在才表示完成云端交付。

接口：`GET /api/catalog/hierarchy?id=osm:relation/9511883&limit=50` 返回当前地点、从根到直接父级的祖先、直接子项及 `nextCursor`。可按原类别过滤子项，不提供 `hasMore`。`GET /api/catalog/hierarchy-coverage` 返回构建覆盖率。原详情、搜索和聚类接口增加 `geometricHierarchy`，同时返回本规则的 `parentId` 和 `hierarchyLevel`。旧高德/模型覆盖层不会覆盖已发布的几何父级。

当前验证：7 项 Python 几何/提取/读接口检查和 24 项相关 Node 检查通过，含真实故宫边界与太和殿完整轮廓样例。景区卡片可汇总后代，但保留真实 `parentId`、层级，并用 `displayParentId` 表示卡片归组。

服务器终端控制超时，由用户执行启动命令。修正首轮依赖路径错误后，北京时间 2026-10-12 23:26:55 重新启动；发布版本的完成时间为 2026-10-13 02:05:32，耗时约 158.6 分钟。2026-10-13 经既有只读隧道实测 `/hierarchy-coverage`、`/hierarchy`、`/coverage`、`/health` 均可用，活动构建 ID 为 `237c5226418d25040705594ab56a5f0605d564d577cd0214af8f51af2621bb71`。本次完成证据来自已发布数据库版本及实际接口响应，未直接读取服务器批次退出状态和 reader-receipt 文件。

发布统计：8 个地区、4,566,067 个唯一地点，3,575,362 个映射点和 990,705 个完整几何对象，327,647 个可作父容器的景点面；190,937 个地点获得直接父级，实际最大深度 5，超过 8 层需压缩的数量为 0。原类别及原 POI 修改数均为 0，地图和模型调用数均为 0。全库计算完成不表示每个地点都有父级；包含它的景点面须在现有来源中存在。

接口样例已读回：太和殿 `osm:way/638449347` 的直接父级为故宫 `osm:relation/9511883`，层级为 2。故宫有 70 个直接子项，涵盖历史文化、景点、餐饮、休闲、购物和服务。另观察到故宫博物院标签节点也作为故宫面的子项返回，这是点/面实体去重尚待处理的现象，本次没有改写原始实体。验收数据见 `validation/containment-hierarchy-completed-20261013.json`；历史启动记录见 `validation/containment-hierarchy-launch-20261012.json`。

### 景点实体去重与别称（2026-10-13，服务器已启动，待全量验收）

一个真实景点只保留一个产品主 ID，其余来源名称作为别称搜索；原 OSM 对象、原类别、人工资料和原 site 成员记录不删除。`entity_identity.py` 使用原名称/别称或显式 Wikidata/Wikipedia 身份与几何条件联合判定：点必须落在同一景点面内；两个面须有至少 98% 的重合面积（交集 / 较大者）；点与点必须有共同显式身份且相距不超过 15 米。不同 Wikidata、不同院区/入口、泛称以及只有距离或模糊名称相似的对象不会自动合并。每个成员必须直接匹配主对象，不通过 A≈B≈C 的链式相似扩大合并。

故宫区域面与故宫博物院标签点作为用户已确认的同一游览实体，记录在 `entity_reviewed.json`；执行时再次校验 ID、名称及点在区域内。这是产品选择，不把它们的不同 Wikidata 对象解释为同一知识实体。太和殿等真实子景点保留为独立地点。

`rebuild_entities.py` 全库扫描既有四类可游玩地点，复用完整几何，无需重读 PBF 或调用外部接口。主对象优先完整面；建立版本化 `entity_members`、`entity_aliases`、`entity_edges`、`entity_summary`，旧 ID 一跳解析为主 ID。子项重挂后重新核验完整包含、无自环和最多 8 层，不凭合并推断空间关系。开放时间等资料按已有证据状态与时效选用，来源及冲突备选保留，不继承景区其他子项的信息。

`entity_catalog.py` 为现有只读网关增加主实体适配：普通搜索在 LIMIT 前去重，详情兼容旧 ID，批量及聚类输入只返回主对象，`/hierarchy` 返回去重后的父子层级。`/entity-coverage` 返回去重版本和统计；本机后端对应 `/api/catalog/entity-coverage`。`aliases` 可搜索，`entityIdentity`、`possibleDuplicateIds`、`sourceRecords` 保留映射和来源。前端所用的旧名称/距离启发式不会再次合并两个不同的主 ID，原“想去”记录可以通过旧 ID 继续匹配。`/site` 仍是未改写的来源成员关系，不用作产品去重后的层级。

启动文件为 `validation/entity-dedup-package/run-on-server.txt`，须在既有服务器 OrcaTerm 中完整执行。后台入口 `start_entity_dedup.py` 不新增 SSH 密钥或定时任务，先写本次 running 状态，结束后自动部署和验证只读接口；失败会记录错误，读服务验收失败则恢复读代码及旧主实体版本。状态目录为 `/home/ubuntu/seatraces-osm/audits/entity-dedup/`。全量算法完成并不等于所有潜在别名已找到，缺少足够身份依据的记录仍独立保留。

本机 7 项身份/搜索结构/证据保留检查、20 项相关 Node 检查通过；服务器启动包重跑 7 项身份检查通过。用户回传确认北京时间 2026-10-13 10:13:41 启动，worker PID 3994297，阶段 `rebuild_entities.py`。10:14 经只读接口检查原服务为 live，`/entity-coverage` 尚未安装；这不能单独证明批次仍在运行或已经失败。发布验收会实查故宫、故宫博物院、Palace Museum、太和殿以及聚类输入。目前尚无全量去重完成统计或发布验收结果。启动证据见 `validation/entity-dedup-launch-20261013.json`。
