# SeaTraces Mac 本地后端开发指南

适用于在 Mac 上修改后端，并通过本机浏览器验证的团队成员。代码、业务后端和测试账号数据库运行在自己的 Mac 上；云端正式服务仍使用 `https://trip.seatraces.com`，本机改动不会自动发布到线上。

按顺序完成以下步骤。首次启动先验证登录与地图，再接入云端地点服务。

## 端口关系

```text
Mac 浏览器 http://127.0.0.1:8788
              ↓
本机前端 8788
              ↓ /api 与 /_AMapService 同源代理
本机后端 8787
              ├─ 本机业务 PostgreSQL，默认 54329
              ├─ 高德与 DeepSeek，使用本机 .env 配置
              └─ OSM 地点服务，需要另行配置只读连接
```

电脑浏览器无需端口映射，无需在腾讯云防火墙开放 8787、8788 或数据库端口。旧的 8787 页面入口仍可打开，本指南统一访问 8788。不要在 localhost 和 127.0.0.1 之间来回切换登录入口。

## 准备项目和依赖

使用 Node.js 24 和 Git。Node 安装包的架构应与 Mac 一致；在终端检查：

```bash
node -v
npm -v
git --version
node -p 'process.platform + " " + process.arch'
```

Node 应显示 `v24.x`。Apple 芯片的原生 Node 显示 `darwin arm64`，Intel Mac 显示 `darwin x64`。

首次下载项目：

```bash
git clone https://github.com/wangjr20210114-hue/seatraces.git
cd seatraces
npm ci --include=dev
```

已经有项目时，直接进入已有的 `seatraces` 文件夹安装依赖，不必再次克隆。所有后续命令都在包含 `package.json` 的项目根目录执行。

本项目的本地 PostgreSQL 依赖安装脚本与平台二进制。不要使用 `--ignore-scripts`、`--omit=optional`，也不要从 Windows 复制 `node_modules`。用普通用户运行，不使用 `sudo npm`。

## 准备本机环境配置

团队仓库包含 `.env.enc`，解密密码由负责人通过私下渠道提供。在交互式终端执行：

```bash
node scripts/team-env.mjs decrypt
```

输入密码时不会显示字符，完成后项目根目录生成 `.env`。已经有 `.env` 时脚本会停止；先自行备份或移动旧文件再决定是否解密，不直接覆盖。

配置文件应至少包含所需功能的以下字段：

| 字段 | 用途 |
| --- | --- |
| `AMAP_JS_KEY` | 浏览器高德底图使用的 Web 端 JS API Key |
| `AMAP_JS_SECURITY_CODE` | 与上述 JS Key 配套的安全密钥 |
| `AMAP_KEY` | 后端高德地点搜索、匹配和路径等 Web 服务 |
| `DEEPSEEK_API_KEY` | 模型功能 |
| `OSM_SERVICE_URL` | 自建地点服务地址；复制配置不代表已建立连接 |

`AMAP_KEY` 不能代替 `AMAP_JS_KEY`。只有 `.env.example` 或 `.env.enc` 而没有解密得到的 `.env`，后端不会自动取得密钥。不要把 `.env` 放进 `public/` 或提交 Git。

可以执行下面的只读检查，只输出是否有值，不输出密钥，也不调用供应商：

```bash
node --input-type=module <<'NODE'
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
for (const key of ['AMAP_JS_KEY', 'AMAP_JS_SECURITY_CODE', 'AMAP_KEY', 'DEEPSEEK_API_KEY']) {
  console.log(key + ': ' + (process.env[key]?.trim() ? '已填写' : '未填写'));
}
NODE
```

“已填写”不等于密钥有效或权限已经通过；运行中的后端是否加载配置，见下方地图排查。

## 启动本机后端

终端一进入项目根目录，执行：

```bash
HOST=127.0.0.1 PORT=8787 \
APP_ORIGIN=http://127.0.0.1:8788 \
SKIP_MIGRATIONS=false REQUIRE_POSTGIS=false \
npm run dev
```

该命令会初始化或复用 `.runtime/pg` 中的本机 PostgreSQL，设置本机数据库连接，执行本机建表流程，并在 8787 启动后端。无需先安装独立 PostgreSQL 或 Docker，也不要把正式业务库连接串用于此步骤。

成功时会看到类似输出：

```text
Local PostgreSQL ready on 127.0.0.1:54329
SeaTraces ready: http://127.0.0.1:8787
```

保持终端一运行。`npm run dev` 当前不是自动重载模式，后端代码或 `.env` 改动后，需要按 Ctrl+C 停止，再重新运行上述命令。

本指南使用 `npm run dev`。`npm start` 不会自动准备本机数据库，只有自行配置好数据库及环境时才使用它。

## 启动本机前端

新开终端二，也进入同一个项目根目录，执行：

```bash
FRONTEND_HOST=127.0.0.1 FRONTEND_PORT=8788 \
FRONTEND_API_ORIGIN=http://127.0.0.1:8787 \
npm run frontend
```

这里明确把前端连接到自己的本机后端，避免之前配置过的云端地址仍然生效。当前前端启动器直接读取进程环境，因此请保留命令前的这些参数。

保持两个终端运行，浏览器打开：

```text
http://127.0.0.1:8788
```

首次创建本机测试账号。云端账号、行程和登录状态不会自动复制到本机。只修改 `public/` 中的前端文件时，刷新页面查看变化即可。

## 验证服务与地图

可在第三个终端执行以下两个只读检查：

```bash
curl --fail --silent --show-error http://127.0.0.1:8788/frontend-health
curl --fail --silent --show-error http://127.0.0.1:8788/api/health
```

第一项验证独立前端；第二项验证“前端代理 → 后端 → 业务数据库”，都应返回包含 `"ok":true` 的 JSON。它们不会验证 OSM、模型或高德供应商是否可用。

若首页只有“地图准备中 · 可以先制订旅行方案”（新版为“地图暂未配置”），登录后在同一浏览器打开：

```text
http://127.0.0.1:8788/api/maps/config
```

| 返回 | 应对方式 |
| --- | --- |
| `enabled: false` | 后端没有读到完整的 JS Key 和安全密钥。检查项目根目录 `.env`，重启后端后刷新。继续等待不会使地图出现。 |
| `enabled: true` | 后端已启用配置；若仍无地图，再检查浏览器 Network/Console 中高德脚本、地图请求、Key 配套关系、来源白名单或网络错误。 |
| HTTP 401 | 先在当前本机入口注册或重新登录。 |
| HTTP 503，`backend_unavailable` | 8788 前端未连接到 8787 后端。检查终端一是否仍在运行及终端二的代理地址。 |
| 页面无法连接 | 先确认 8788 前端进程已启动。 |

排查时只提供状态码、`enabled` 和已去除凭据的错误信息，不转发接口中的 Key。`npm run providers:status` 当前检查的地图项是 Web 服务 Key，不能单独证明 JS 底图配置完整。

## 接入云端地点库

高德底图显示与自建 OSM 地点查询是两条链路。前面的步骤能准备本机账号和业务服务；完整城市候选、景点聚类等功能仍需要可访问的地点服务。

配置中的 `OSM_SERVICE_URL=http://127.0.0.1:8791` 指自己的 Mac。只有管理员为该成员建立了到服务器只读地点服务的连接，这个地址才有效；负责人的 Windows 隧道不会随 Git 仓库或 `.env.enc` 一起复制。

请让负责人为该成员配置独立的只读地点连接，或提供另行授权的开发服务地址。不要直接把 `OSM_SERVICE_URL` 改成 `https://trip.seatraces.com/api`，两者接口路径和鉴权方式不同。没有地点连接时，先验收登录和底图，城市聚类失败应单独排查。

## 常见启动错误

| 问题 | 处理 |
| --- | --- |
| `npm: command not found` | 安装 Node.js 24 后重新打开终端，确认 `node -v` 和 `npm -v` 可用。 |
| 找不到 `package.json` | 当前目录不对，先进入克隆得到的项目根目录。 |
| 缺少 `embedded-postgres`、平台二进制或安装链接 | 在 Mac 上重新完成 `npm ci --include=dev`；确认没有禁用安装脚本或可选依赖。 |
| `EADDRINUSE` | 端口已被占用，先查清对应进程，不要盲目结束其他程序。 |
| 本机账号登录失败 | 使用本机注册的账号；云端账号不会自动同步。 |
| 改完后端没有效果 | 重启终端一；确认终端二指向本机 8787，而不是云端。 |
| 地图出现，但景点检索或聚类失败 | 单独检查 OSM 只读连接，不要把它误判为地图 JS Key 问题。 |

查看端口占用：

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
lsof -nP -iTCP:8788 -sTCP:LISTEN
lsof -nP -iTCP:54329 -sTCP:LISTEN
```

结束开发时，分别在两个运行终端按 Ctrl+C。本机用户和行程保存在 `.runtime/pg` 中；不要通过删除 `.runtime` 来处理一般启动故障。

本机只读源码检查可运行 `npm run check`。完整测试及真实供应商调用按具体修改选择执行，不需要为了启动服务反复消耗地图或模型额度。

本指南根据项目现有启动脚本核对；Mac 首次实际启动仍需在该成员电脑上确认。
