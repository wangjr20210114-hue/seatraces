# 腾讯云部署

## 当前团队服务

2026-10-14 20:25（北京时间）已为 `ubuntu` 和 `seatraces_dev` 开通共享源码读写：`/srv/seatraces` 指向当前 `drawer-4c6f2f57bb8f` 发布包原有的源码目录，未另建 checkout。安装时核对了 119 个应用文件与运行容器一致，并以两个账号验证读写权限；源码和 ACL 备份位于 `/var/lib/seatraces/shared-source/`。队友未获得 sudo/Docker 管理权限，线上容器没有重启。双方通过 Remote SSH 打开 `/srv/seatraces` 才是在编辑同一批文件；各自电脑上的源码不会自动同步。

2026-10-15 已在原目录补入完整 Git 历史，`/srv/seatraces` 现为真实仓库，跟踪 `main → origin/main`，远端为 `https://github.com/wangjr20210114-hue/seatraces.git`。两个账号均通过 pull 预检查，原源码保留。**发布前必须先保留服务器中的团队修改**；下面的一键发布检测到未提交修改会停止。Git pull 只更新源码，部署完成才会更新线上镜像。

## Windows 本地开发 → Git → 服务器

在项目根目录使用 `dev-local.cmd`。它启动本机 PostgreSQL、8787 API、8788 前端，开启 Node 热更新，并为已运行的模拟器映射 8788。首次更新客户端运行 `dev-local.cmd -Build -Install`；普通开发直接双击 `dev-local.cmd`。DevEco 路径不同时加 `-DevEco "你的安装目录"`，仅浏览器联调加 `-NoDevice`，强制重启本项目服务加 `-Restart`。

模拟器顶部 **连接设置 → 本地开发** 对应 `http://127.0.0.1:8788`；**团队服务器** 对应 `https://trip.seatraces.com`。选择会保存，重启应用后仍生效。修改后端代码自动重启本机 API，修改前端后点击顶部“刷新”。`.env` 修改须重新运行 `dev-local.cmd -Restart`。只有改 ArkTS 原生壳时才需要重新构建/安装 HAP。

本机与服务器使用各自的账号、Cookie、行程和业务数据库，不自动复制测试数据。OSM 可复用已授权的只读地点连接；复制 `.env` 不会自动授予地点库访问权。脚本不使用生产 `DATABASE_URL`，本机数据留在 `.runtime/pg`。

### 一次性安装部署连接

1. 本机安装 Node.js 24、Git for Windows、OpenSSH 客户端，配置 GitHub 推送权限；不在仓库内保存 Token。
2. 执行 `python scripts/prepare-deploy-access.py`，生成本机专用 SSH 密钥、固定服务器主机密钥和安装命令，全部保存在忽略的 `.runtime/deploy-access/`。
3. 由服务器管理员确认长期部署权限后，将 `.runtime/deploy-access/run-on-server.txt` 全文粘贴到以 ubuntu 登录的终端。安装器把部署程序放入 root 管理的固定位置，只开放 `check`、`deploy <main提交>`、`status <提交>` 三类命令；该密钥禁止 shell/SFTP/端口转发，不新增 sudo 或 Docker 用户组权限。
4. 本机执行 `publish-deploy.cmd --check`。通过后即可日常双击 `publish-deploy.cmd`。

密钥长期有效，直到管理员撤销。撤销时在服务器执行 `.runtime/deploy-access/revoke-on-server.txt`；它只移除这把部署公钥，保留原有登录权限。私钥仅留在本机，不通过 Git 或手机分发。新增电脑须由管理员单独配置，不能复制其他人的私钥。

### 日常发布

先在本地验证，将开发分支合并到本机 `main`，再运行：

```bat
publish-deploy.cmd
```

脚本列出文件，要求填写提交说明并确认，然后执行：本机/服务器预检查 → 凭据检查 → `npm run check` → commit → push main → 服务器 fetch 并快进合并同一个提交 → 构建独立镜像 → 备份业务库 → 切换前后端 → 健康、静态文件版本、匿名鉴权验收。Git 网络故障最多尝试 3 次，目录权限等错误直接停止并显示具体原因；拉取成功后本地快进合并，避免重复下载。失败会尝试恢复旧镜像，并核对后端健康。Git 提交和备份会保留，服务器源码可能已更新；以部署结果判断线上版本。

```bat
publish-deploy.cmd --message "修复行程展示" --yes
publish-deploy.cmd --message "修复接口" --only server/services/example.mjs
publish-deploy.cmd --retry 完整40位提交SHA
```

`--only` 可重复指定，本次范围外已暂存文件会阻止提交；默认提交所有未被忽略的变更。没有文件变更时直接推送并部署现有 main。脚本不会强推、自动合并开发分支或覆盖服务器未提交修改。Git 认证失败先修复账号/网络；部署连接失败发生在 commit/push 之前。

**当前自动发布支持普通前后端代码更新。** `server/` 内 SQL 文件、Dockerfile 或 `.dockerignore` 变化时停止，须管理员先审查数据库迁移或构建策略；它不会自动把开发数据库覆盖到服务器，也不会把新数据库结构假装部署成功。HAP 是独立客户端产物，一键发布服务器不会替换手机已安装的 HAP。

服务器部署记录：`/var/lib/seatraces/git-deploy/<提交SHA>.json` 和 `.log`，备份位于 `/home/ubuntu/seatraces-app/backups/`。并发发布会被拒绝；GitHub main 在推送/拉取期间变化时也会停止，防止部署到其他人的提交。服务器一直运行的服务仍由 Docker 管理，不依赖电脑保持在线。

2026-10-14，旅行应用已部署到 `https://trip.seatraces.com`。原 `seatraces.com`、`www.seatraces.com`、`face.seatraces.com` 站点配置保留。用户添加了 `trip` 的 A 记录，Caddy 管理 HTTPS 证书；HTTP 跳转 HTTPS。

| 部件 | 当前部署 |
| --- | --- |
| 外部入口 | `https://trip.seatraces.com`，业务接口 `/api`，须账号 Cookie |
| HTTPS 入口 | 现有 `docker-caddy-1`，加载 `/opt/shiguangji/infra/docker/Caddyfile.iptest` |
| 独立前端 | `seatraces-business-frontend-1`，仅监听 Docker 私网网关 `172.18.0.1:8788` |
| 业务 API | `seatraces-business-backend-1`，仅监听 `127.0.0.1:8787` |
| 用户和业务库 | 原 PostgreSQL 容器中的独立 `seatraces_business` 数据库，应用角色 `seatraces_business_app` 无建库/建表/授权权限 |
| OSM 地点服务 | 同机 `127.0.0.1:8791`；无需经过开发电脑的 SSH 隧道 |
| 运行目录 | `/home/ubuntu/seatraces-app`，`compose.yaml` 与私有 `.env.deploy`、`backend.env` |
| 恢复资料 | 运行目录的 `backups/`；Caddy 原配置为 `Caddyfile.iptest.before-trip` |

两个应用容器启用 `restart: unless-stopped` 和健康检查。后端停止不影响静态前端打开；API 会明确返回暂不可用。没有发布 8787、8788、8791、55432 到公网。前端信任核对过的 Caddy 网段，后端只信任回环代理，避免伪造客户端地址绕过限流。

本次从本机一致性快照导入 26 张表，逐表核对行数，含 28 个账号记录、23 份历史行程、48 份行程版本、1 份 CityWalk、34,228 条业务地点/城市记录。456 万级 OSM 地点仍在原 OSM 库中，不属于此业务表计数。`sessions`、`account_tokens`、`auth_rate_limits` 不迁移；所有人重新登录。配置和数据备份不进入 Git。

```sh
cd /home/ubuntu/seatraces-app
sudo docker compose --env-file .env.deploy ps
sudo docker compose --env-file .env.deploy logs --tail 50 backend
sudo docker compose --env-file .env.deploy restart backend
curl --fail https://trip.seatraces.com/api/health
```

`deploy/compose.server.yaml` 是此次部署模板，采用 Linux host 网络访问既有回环 OSM/数据库，监听地址仍分别限制为回环与 Caddy 私网网关。不要直接替换为容器默认桥接网络，也不要把监听地址改为 `0.0.0.0`。Caddy 网络若重建并改变网关，应同步核对 `.env.deploy` 中网关、可信 CIDR 和 Caddy upstream。

首次迁移工具：`node deploy/export-business.mjs` 在 `.runtime/backend-deploy` 生成私有 SQL 快照；`deploy/prepare-release.mjs` 分别准备不含凭据的源码包和私有供应商配置；`deploy/import-business.py` 校验哈希，只导入全新数据库，目标库已存在则拒绝覆盖。`deploy/verify-server.py` 核对最小权限、表计数和服务健康。应用日常数据保存在 PostgreSQL 中；这些 SQL/清单仅供部署和恢复。

更新时先备份业务库并保留上一个镜像标签，再构建新标签、运行必要迁移、更新 `.env.deploy` 的 `SEATRACES_IMAGE`，执行 `sudo docker compose --env-file .env.deploy up -d`。普通应用回滚切回旧镜像；不要覆盖云端数据库为过期本机快照。只有要撤下本次站点时才恢复专门保存的 Caddy 备份，并在 reload 前检查之后是否还有其他站点改动。

已通过公网 HTTPS、注册/登录会话、退出失效、匿名访问拒绝、城市检索、故宫实时检索、历史接口和 CityWalk 接口验证；未在本次重新构建 HAP 或验收真机定位。邮件服务仍待配置，高德控制台应允许 `trip.seatraces.com` 的 JS API 来源。下文旧 Compose/Nginx 步骤是其他独立环境的部署参考，不是当前服务器的执行方式。

## 其他环境部署参考

推荐一个独立子域，例如 `app.seatraces.com`，API 与页面同源 `/api`，减少跨域和 Cookie 配置。域名、证书和现有站点用途需先核对。数据库不开放公网 5432。

2026-10-11 的只读核对：`seatraces.com` 指向 124.223.110.193，`app.seatraces.com` 尚无 DNS 解析。服务器 80/443 已由现有 `docker-caddy-1` 容器使用，主机没有运行 Nginx；不能直接启用下方 Nginx 示例抢占入口。后续公网发布应在核对并备份既有 Caddy 配置后增加独立站点。当前未修改 DNS、Caddy 或公网权限。原 Compose 中的 `127.0.0.1:8791` 在容器内不指向宿主机，生产部署还须另行设计私有网络或 Unix socket，不能直接视为已接通。

### 已授权的本机开发连接

2026-10-11 用户明确批准新增并长期保留本机专用开发连接，直到主动要求撤销。独立 Ed25519 公钥已安装，标记为 `seatraces-catalog-development`。服务器只允许转发到 `127.0.0.1:8791`，禁止 shell、SFTP、PTY、代理与 X11。远程监听也限制在同一个回环端口，不能请求公网反向监听。数据库账号和端口继续留在服务器内部。真实验收确认服务器命令被强制拒绝、55432 数据库转发返回 administratively prohibited。

授权配置和私钥仅存于 `.runtime/catalog-access/`，私钥文件权限限定当前 Windows 用户；不打包、不放入 HAP、不提交 Git。这个方案适用于本机原型和连接本机的模拟器，不能替代手机正式使用的 HTTPS 后端。它与以前已删除的临时密钥相互独立，不会在本轮结束时自动移除。当前 `start.ps1` 会启动或复用连接，`npm run dev` 用户则先手动运行连接脚本。

管理入口（缺少本机授权配置时拒绝启动）：

```powershell
powershell -File scripts/connect-catalog.ps1
powershell -File scripts/connect-catalog.ps1 -Stop
```

客户端只绑定本机 8791，校验服务器已知主机密钥，遇到主机密钥变化、认证拒绝或端口冲突停止重试。短暂网络失败最多自动重试五次。停止本机连接并不撤销服务器公钥；撤销时通过正常腾讯云维护登录，运行 `catalog_access.py --public-key <本批公钥文件> --revoke --apply`，然后停止本机连接并删除本批密钥。

## 首次部署次序

1. 安装受支持的 Docker Engine / Compose；复制源码（不含本机 `.runtime`、密钥、node_modules）。
2. 从 `.env.example` 创建 `.env`，设置随机强密码 `DB_OWNER_PASSWORD` 与 `DB_APP_PASSWORD`，不要使用示例字符串。URL 密码须进行 URL 编码或使用只含 URL 安全字符的随机密码。
3. `docker compose up -d db`，等待数据库健康。
4. owner 执行 `server/schema.sql` 和 `server/postgis.sql`，再执行 `deploy/roles.sql`；以 psql 变量 `app_password` 传入应用密码，避免输出密码或提交至 Git。
5. `docker compose up -d --build app`。应用启用 `SKIP_MIGRATIONS=true` 与 `REQUIRE_POSTGIS=true`，启动时检查扩展。
6. 为 HTTPS 子域配置 Nginx，参考 `nginx.conf.example`。确认 TLS 证书有效后再接入手机客户端。
7. 通过注册创建自己的账号，再由数据库 owner 明确提升指定用户为 admin。生产禁用自动演示管理员，不按“第一个注册用户”自动授予管理员权限。
8. 导入 GeoNames 和具有许可的真实 POI；以配置的 `DATABASE_URL` 运行导入脚本。源数据导入不会等于“完成事实核验”。

运行 DDL 示例（不包含真实密码）：

```sh
docker compose exec -T db psql -U seatraces_owner -d seatraces < server/schema.sql
docker compose exec -T db psql -U seatraces_owner -d seatraces < server/postgis.sql
```

角色脚本仅首次执行；后续升级应有版本化迁移，避免重复创建同名角色。此原型使用幂等 schema 初始化，尚未实现完整生产迁移回滚框架。

## 数据可靠性

- 用 `backup.sh` 生成 `pg_dump -Fc` 逻辑备份；必须加密并复制到另一存储位置。
- 在独立空数据库执行 `pg_restore` 演练，确认账号、行程、版本、帖子和空间索引可恢复。
- 持续监控磁盘余量、连接池、慢 SQL、5xx、接口用量；数据量扩大后使用 WAL 归档和时间点恢复。
- 单台 2 核 4 GB 实例没有多机高可用。后续若正式运营，可采用腾讯云托管 PostgreSQL 或主备实例。
- 应用密码不具备 DDL 权限；数据库 owner 密码不提供给应用容器。

## 独立 Compose 模板的验收范围

顶部列出的 trip.seatraces.com 部署已完成应用镜像、数据库权限、HTTPS 和 Cookie 接口验收。若采用本节旧的独立数据库 Compose/Nginx 模板，仍须针对那个环境单独验证。供应商页面效果、跨端操作和真实设备定位不在本次服务器接口验收范围内。

真实地图、导航、铁路、航班服务可能涉及按量费用。系统内 200 元限制使用每请求预留估算；每家供应商仍应独立设置硬额度和告警。不得把此估算当成真实账单精度。

## 已部署的 OSM 地点服务

服务器目录 `/home/ubuntu/seatraces-osm`，容器 `seatraces-osm-db`，数据库 `seatraces_osm`。实际版本 PostgreSQL 16.9 / PostGIS 3.5.2；固定镜像摘要 `postgis/postgis@sha256:94146ac37bc61e2322f88016056c5920729cb8c64c8542ed590af8fc2abdac07`。仅绑定 `127.0.0.1:55432`，无需开放公网数据库端口。容器内存上限 768 MiB、CPU 上限 0.75 核，保留原有应用容器。正式运营前仍须安排受支持镜像补丁更新、负载评估和独立存储备份。

| 路径 | 内容 |
| --- | --- |
| `raw/` | 官方 China、Taiwan 以及日本、韩国、泰国、越南、马来西亚/新加坡/文莱、马尔代夫原始 PBF，包含原始道路、无名称要素和标签；JSON 记录来源、字节数、MD5、SHA-256 |
| `processed/` | 有名称地点的压缩 JSONL 与快照校验清单 |
| `pgdata/` | PostgreSQL 持久化目录，由容器管理，禁止手工编辑 |
| `scripts/osm/` | 本仓库 `scripts/osm/` 的部署副本 |
| `database.json` / `database.env` | 数据库管理连接信息，权限 0600，不分发、不提交 Git |
| `reader.json` | 经用户明确授权创建的只读检索账号，权限 0600；不提供给手机 |
| `verification.json` | 最近一次查询、权限、版本与数据验收报告，不含密码 |
| `backups/` | `pg_dump` 自定义格式备份及校验/恢复结果 |

在服务器以 ubuntu 登录后查询：

```sh
cd /home/ubuntu/seatraces-osm
python3 scripts/osm/reader_server.py --query 拙政园 --category attraction
python3 scripts/osm/reader_server.py --query '' --lon 121.49 --lat 31.24 --radius 3000
python3 scripts/osm/verify_server.py --raw
python3 scripts/osm/backup_server.py --verify-restore
```

SQL 接口 `osm.search_places(关键词, 分类, 经度, 纬度, 半径米, 条数)` 支持名称/多语言别名包含匹配、分类和附近检索；默认 30 条，上限 100 条。无坐标时至少输入两个字符。支持 pg_trgm、中文双字符 GIN 与 PostGIS GiST 索引。它是地点检索，不是商业地图 POI 匹配、导航或道路最短路径服务。

结果优先匹配地点本名和语言别名，其次才是地址文本；例如查询 `Malé` 时城市别名排在只有地址包含该词的商店之前。`relevance.sql` 显式使用 PostgreSQL 的 `und-x-icu` 排序规则处理带重音字母的大小写；本机与服务器均已验证该排序规则存在。同名对象仍需结合城市、分类和坐标判断，名称排序不能代替实体去重。

只读账号只能读取 osm 表、执行查询，不能增删改或建表，连接数上限 4，角色查询超时 5 秒。新增地点库页面已通过只读 HTTP 服务完成全链路检索、详情与起终点选择验收；自动行程规划仍使用原来的 GeoNames/示例库。

### 已启用的常驻地点 HTTP 服务

2026-10-11 已通过现有腾讯云维护会话部署 `seatraces-osm-catalog.service`，状态为 active/running/enabled。服务只绑定 `127.0.0.1:8791`，使用原有 `reader.json`；没有新增访问凭据、开放防火墙或公网监听。服务内单条查询超时 4 秒、最多 2 个数据库查询并发。systemd 负责故障重启与开机启动，进程采用只读文件系统、256 MiB 内存上限和 64 个任务上限。

已执行单服务重启，核对 PID 更换、健康检查、八个提取区及 4,567,502 行覆盖信息；未重启服务器或验证整机启动顺序。报告在 `/home/ubuntu/seatraces-osm/catalog-service-systemd.json`。

```sh
sudo systemctl status seatraces-osm-catalog.service
sudo systemctl restart seatraces-osm-catalog.service
sudo journalctl -u seatraces-osm-catalog.service -n 50 --no-pager
curl --fail http://127.0.0.1:8791/health
```

重装前先检查现状；`scripts/osm/install_catalog_service.py` 默认仅校验，`--apply` 才部署。安装器遇到不同内容的已有同名 unit 会拒绝覆盖；首次替换只终止命令行及 UID 均匹配的原服务。完整应用直接运行在同机时可使用 `OSM_SERVICE_URL=http://127.0.0.1:8791`；容器部署须按前述私有网络方案另行配置。本机开发端已启用用户明确授权的持久受限连接，独立手机仍需旅行应用 HTTPS 后端。不要把此无公网鉴权的私有 HTTP 服务直接暴露到互联网。

国内与国外两批临时 SSH 公钥均已分别移除，真实登录验证均返回认证拒绝，各批本地临时私钥也已删除。后续维护请通过自己的正常登录方式访问服务器，不依赖本次临时密钥。最新全部八个活动提取区的数据库备份和独立恢复演练均已通过，校验记录随源码保留。

## OSM 更新和恢复

本次服务器直连 Geofabrik 超时，采用本机下载、校验、SSH 上传，再在服务器校验和导入。服务器网络恢复后，也可在那里运行 `download.py`。更新由运维手动执行，未添加定时任务。

本机使用隔离 Python 环境安装 `scripts/osm/requirements.txt`，在项目根目录运行：

```sh
python scripts/osm/download.py china taiwan --directory data/osm/raw
python scripts/osm/extract.py data/osm/raw/<China清单中的文件名> data/osm/processed/china.jsonl.gz --cache data/osm/cache/<新的缓存文件名>
```

Taiwan 同理。使用新的缓存文件名，保留原始 PBF、快照与清单；上传完成后才执行 `python3 scripts/osm/import_server.py china` / `taiwan`。导入采用事务、区域锁和活动版本指针；校验/行数不一致则回滚，不会激活半份数据。同一 PBF 与处理产物完全一致时跳过；同一 PBF 对应不同处理产物时拒绝静默覆盖，需要明确迁移处理版本。旧快照保留便于回滚，磁盘不足时先核对版本、备份及引用，再安排清理，不自动删除历史。

国外扩库脚本已支持日本、韩国、泰国、越南、马来西亚/新加坡/文莱合并提取区和马尔代夫；本轮均已入库并完成原始文件校验，见 TEST_REPORT.md。以后更新时，以下命令仅准备本机原始文件与可导入快照，仍须另行上传和导入：

```sh
python scripts/osm/prepare_batch.py maldives south-korea thailand vietnam malaysia-singapore-brunei japan --reserve-gib 8
```

各国依次处理，验证既有产物后可断点继续。Windows 的几何位置缓存由独立进程持有，提取进程成功退出后才删除本次可重建缓存；原始 PBF 和 JSONL 保留。上传原始文件、来源清单、JSONL 和提取清单后，服务器 `import_server.py <区域>` 再核对原始 SHA-256 与提取来源一致，并要求导入前至少空闲 12 GiB。最后执行 `verify_server.py --raw`、`benchmark_server.py` 和备份恢复验证。

上传带宽受限时，可明确使用 `import_server.py <区域> --allow-raw-pending`，先上传已在本机验证来源的 JSONL 及两份清单。服务器仍校验 JSONL SHA-256、行数与源 PBF 哈希关联；缺少完整原始文件时会输出 `raw_archive_pending`，不宣称原始归档已完成。随后续传完整 PBF，并执行 `verify_raw_server.py <区域>` 与最终 `verify_server.py --raw`。应将“可检索地点已入库”和“原始文件已在服务器校验”作为两个独立状态。

日本大文件传输另提供 `receive_parts_server.py`：按来源清单生成连续且不重叠的分块清单，接收时核对每块长度和 SHA-256，仅把通过校验的块标为完成；全部块齐备后合并，再核对完整 PBF SHA-256 才替换原始归档。合并前检查 12 GiB 磁盘储备。中断后可从未完成块的已有字节续传，已有前缀也重新参与整块哈希计算；校验失败的块不会被激活。`test_receive_parts.py` 覆盖损坏块拒绝、截断续传及完整合并。

`benchmark_server.py` 使用服务器已有只读账号，以 10 条结果为上限，分别记录首次查询及 10 次重复查询的 P50/P95，再做两个连接共 56 次有限查询。报告保存为 `benchmark.json`；它测量服务器本机数据库访问，不包含手机、HTTP API 和公网传输，不能视为生产容量承诺。

回滚通过事务把 `osm.active_imports.import_id` 指回该区域先前验证过的 `osm.imports.id`。先用 SELECT 核对区域、时间和行数，再修改；原始备份还可用 `pg_restore` 恢复到独立空库验证后切换。`backup_server.py --verify-restore` 会新建自己的 `osm_restore_*` 临时数据库，核对各快照计数、活动版本、示例查询和空间索引，再清理本次临时库。它不删除当前数据库。备份目前仍在同一服务器，应另做异地副本；这不是高可用或时间点恢复方案。

OSM 字段均以源标签为准：没有开放时间/城市/费用的字段保持空；费用标签不等于实时价格；面状景点的代表点不等于入口；不同 OSM 对象可能指向同一真实地点，不能只凭重名合并。坐标为 WGS84，接入采用 GCJ-02 的服务商时必须显式转换。道路已保留在原始 PBF 中，但未建成路由图或离线导航引擎。
