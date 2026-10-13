# 后台接口接入与职责划分

本轮范围：高德、DeepSeek 接入，以及现有地点与供应商代码整理。保留现有 HTTP 接口和返回格式，不改前端、模拟器、服务器数据库或行程算法。2026-10-11 16:52（北京时间）已完成两家供应商的真实连接及本机应用验收；主服务已重启加载本机配置。

当前可用：高德 POI 搜索、逆地理编码、OSM 地点候选匹配、步行及公交路线；DeepSeek 结构化 JSON 和自有题库选题。公交样本返回 5 个方案，包含步行、地铁、公交和换乘分段。本轮没有验收底图 SDK、实机导航、境外路由、实时票务或模型联网搜索。

## 你现在需要准备的内容

只需两个平台的开发者账号和各一把服务端 Key。登录、验证码、认证信息、协议及充值由账号持有人在官方页面处理；无需向聊天提供密码、密钥或证件。当前在本机验收，不需要新增服务器登录权限或配置 seatraces.com。

### 高德

1. 打开 [高德控制台](https://console.amap.com/)，注册/登录并按页面要求完成开发者认证。
2. 应用管理 → 创建应用，名称可用 `SeaTraces 海迹`，用途按实际填写旅行行程推荐。
3. 添加 Key，服务平台选择 **Web 服务**；本轮不需要 JS Key、安全密钥或鸿蒙 SDK Key。
4. 查看关键字/周边搜索、逆地理编码、步行及公交路径规划的权限、调用配额和 QPS。Web 服务 Key 不等于每项高级服务都已开放。
5. 当前兼容旧代码默认 `AMAP_POI_VERSION=v5`。若账号没有 POI 2.0 权限，明确改为 `v3` 后再测试基础搜索；系统不自动跨版本重试，避免掩盖权限问题和增加请求。不同版本字段不能假定相同。
6. 按控制台实际提供的方式限制服务端 Key；若启用出口 IP 限制，本机公网出口与将来腾讯云出口分别处理。不自动购买流量包。

官方依据：[创建 Web 服务 Key](https://lbs.amap.com/api/webservice/guide/create-project/get-key)、[基础地点搜索](https://lbs.amap.com/api/webservice/guide/api-advanced/search)、[POI 2.0](https://lbs.amap.com/api/webservice/guide/api/newpoisearch)、[路径规划](https://lbs.amap.com/api/webservice/guide/api/newroute)。

### DeepSeek

1. 打开 [DeepSeek API Keys](https://platform.deepseek.com/api_keys)，注册/登录开放平台。
2. 创建供 SeaTraces 后端使用的专用 API Key。
3. 在控制台确认有可用余额；如需充值，由你选择金额并操作，本轮不要求一次充值全部 200 元预算。
4. 默认模型为 `deepseek-flash`；当前业务仅提交问题偏好、候选地点 ID/名称及用户编辑请求，让模型返回结构化结果，不自动附加账号凭据或设备定位。连接检查只提交合成 JSON。

官方依据：[首次调用](https://api-docs.deepseek.com/zh-cn/)、[模型和计费](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。模型名称和价格可能变化，以开通时控制台及官方文档为准。

## 本机安全配置

在本文件所在的项目目录打开 PowerShell，运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\configure-backend.ps1
```

依次在隐藏输入框输入 `AMAP_KEY` 和 `DEEPSEEK_API_KEY`，直接回车表示保留该项当前值。也可只配置一个平台：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\configure-backend.ps1 -Provider deepseek
```

脚本保留 `.env` 中其他配置，全部输入验证通过后才保存。不启动服务、不充值、不调用供应商。`.env` 已被 Git 和交付打包脚本排除；不要将其放入截图、源码包或客户端。此命令的 ExecutionPolicy 仅作用于本次进程，不修改机器策略。

检查状态（不产生外部请求）：

```powershell
npm run providers:status
```

`configured_unverified` 仅表示有配置；真实调用成功后才能报告某个接口可用。

## 连接验收

本机原型数据库运行后，可执行：

```powershell
npm run providers:check
# 或只检查一个平台
npm run providers:check -- --provider=amap
npm run providers:check -- --provider=deepseek
```

该脚本每次最多调用高德 4 次（地点搜索、逆地理编码、步行、公交），DeepSeek 1 次。仅使用固定公共测试点及合成 JSON，不发送用户行程；不保存供应商地点详情。所有调用共用现有本机 `api_usage` 预算台账，无自动重试。

缺 Key 会报告 not_configured；无权限、无结果、无效 JSON 或超预算会报告失败，不视为已接通。脚本输出功能状态、数量及耗时，不输出密钥、请求头或原始商业地点数据。此项仅是连接与基本结构验收，不能代替真实导航、营业资料正确性或性能验收。

本机预算预留按配置估计，不等于供应商账单，也不能保证实际总支出必然低于 200 元；同时关注供应商控制台余额与限额。配置写入后现有进程不会热加载；独立检查脚本每次读取新配置。本次原型主服务已重启，后续修改配置仍需重启。

应用层验收（服务须已运行，实际收费请求）：

```powershell
node scripts/verify-provider-workflow.mjs --live
# 只测地图：最多 6 次高德调用
node scripts/verify-provider-workflow.mjs --live --maps-only
# 只测公交分段：最多 3 次高德调用
node scripts/verify-provider-workflow.mjs --live --transit-only
```

完整流程最多 6 次高德、1 次 DeepSeek，创建并在 finally 中清理专用临时账号；输出仅为功能状态、数量、耗时和分段类型。步行用相邻景点并验证所选候选确实用于算路，公交使用苏州站到拙政园。已通过的付费检查无需反复执行。

## 当前代码职责

```text
server/
  index.mjs                  HTTP、鉴权、输入输出；本轮保留路由
  providers.mjs              旧导入路径的兼容导出
  catalog.mjs                旧地点模块路径的兼容导出
  config/providers.mjs       供应商配置状态，永不返回密钥
  contracts/catalog.mjs      地点检索输入约束
  domain/place-matching.mjs  名称相似度纯函数
  services/
    catalog.mjs              地点读取、失败后 OSM 快照回退、来源状态
    place-matching.mjs       按名称相关度召回候选并评分；不自动合并或写库
    routes.mjs               按地区/方式选择适配器、统一路线结果
    questions.mjs            自有题库与模型结果的白名单校验
  integrations/
    http.mjs                 预算闸门、超时、禁止重定向、脱敏错误
    amap.mjs                 高德固定端点、密钥与版本、错误码处理
    deepseek.mjs             模型调用及 JSON 完整性检查
    osm.mjs                  只读地点网关传输，不决定缓存策略
    google-client.mjs        保留已有境外调用，当前未启用
    travel-tickets.mjs       保留已有车次/航班适配，当前未验收
    unavailable.mjs          统一的未配置返回
  repositories/
    api-usage.mjs            事务内预算预留，月预算和每日请求限制
    catalog-cache.mjs        只保存已有授权 OSM 来源的恢复快照
    places.mjs               本地业务地点读取
```

`planner.mjs`、`route-model.mjs`、`route-selection.mjs`、`opening-hours.mjs` 等既有计算模块继续保留；本轮没有把它们改成新的聚类/智能行程实现。兼容导出让当前客户端和测试无需同步重写。

### 关键边界

- 业务服务决定“需要什么、如何处理不足”；适配器决定“怎样调用某家 API”。替换供应商时，不应重写问卷和地点质量规则。
- SQL、文件快照放在 repositories；模型不能直接执行 SQL，也不能自行更新事实表。
- 预算 SQL 集中在 api-usage，由公共请求通道统一调用；其他业务代码不额外实现一套付费重试逻辑。
- 缓存仍只用于 OSM 查询恢复，保留 snapshot 标识。高德结果不进入该缓存或 OSM 原始表；允许持久化的具体范围须另行确认授权。
- DeepSeek 的合法 JSON 不代表事实正确；业务仍需校验字段和 ID。联网搜索、证据核查和事实入库必须是后续独立流程，当前适配器未开启联网。
- 后续小闭环已实现“本地候选不足时调用高德”及较小的 place-candidate/1 返回结构，见 [BACKEND_CANDIDATES.md](BACKEND_CANDIDATES.md)。完整 PlaceV1 详情及有效期/冲突处理仍未实现。
- 已知名称的地点匹配采用高德周边查询的 weight 排序，普通附近浏览仍用 distance；修复了距离排序使景点内小设施挤掉主体的问题。本馆等候选仍须明确选择，名称相似和位置接近不等于入口已核验。

## 本轮验收记录

- 重构前 53 项离线测试通过；重构后连同 10 项新边界测试，共 63 项通过。
- 独立本机数据库与新进程中的完整 HTTP 流程测试通过，涵盖账号隔离、并发修改、问卷、行程、社区及未配置供应商状态。临时数据库已清理。
- 新进程读取云端覆盖为 live，4,567,502 条活动提取区记录；地点搜索返回 live 和 2 条结果。
- 重构证据：`validation/backend-refactor-20261011.json`。本次联调修复候选排序后，新增相关回归用例，33 项相关测试通过。
- 真实连接 5 项通过：POI 搜索 289 ms、逆地理编码 105 ms、步行 75 ms、公交 216 ms、DeepSeek JSON 1101 ms。这是一次样本耗时，不是 SLA 或并发压测。
- 应用链路 5 项通过：自有题库返回 3 个允许的问题 ID；拙政园、苏州博物馆两个 OSM 地点匹配；所选高德候选用于步行路线；苏州站到拙政园返回 5 个公交方案。应用层步行 257 ms、公交 563 ms。
- 汇总证据：`validation/provider-acceptance-20261011.json`。保留首次匹配失败、相邻景点公交未满足验收条件的原始报告；没有用成功报告覆盖失败历史。换用距离合适的公交样本后通过，不据此断言所有地点都有公交方案。
- 本轮含诊断调用的本机预算预留共 2.10 元，仅为预算估算，不是平台实际扣费。所有业务验收临时账号已删除。
- 重构前相关源码已保存在 `.runtime/backend-refactor-20261011/`，不含 `.env` 或凭据。原有源码 ZIP 未重新生成，新改动以当前工作目录为准。

后续进展：候选数量与基本质量判定、按需高德补充和统一候选输出已通过有限真实样本验收，见 BACKEND_CANDIDATES.md。资料证据采集与核验、完整 PlaceV1 和聚类规划各自作为后续独立模块。
