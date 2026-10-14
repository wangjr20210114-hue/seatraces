# 地点候选小闭环：已运行版本

2026-10-11，已完成“本地 OSM 检索 → 按需高德补充 → 统一地点结构”，并在本机后端 `127.0.0.1:8787` 启用轻量中文 embedding 排序。云端资料表新增 evidence JSONB，拙政园、留园、苏州博物馆本馆的 10 条官方资料已备份后入库，并通过只读接口读回核对。2026-10-11 策略更新：移除 hasMore，具体地点返回单一最佳候选，新增附近食宿接口，示例排程仅纳入游玩类别；现有示例行程仍使用业务示例库，尚未接成全量 OSM 自动行程。

## 如何调用

新增 `POST /api/catalog/candidates`，使用现有登录会话和 `X-Seatraces: 1`。`/api/catalog/search` 的 `hasMore` 已删除，其余主要字段保留。新增接口可能产生一次付费请求，因此要求登录并使用 POST。

```json
{
  "intent": "named",
  "q": "拙政园",
  "countryCode": "CN",
  "lat": 31.324,
  "lng": 120.624,
  "radius": 15000,
  "category": "scenic",
  "limit": 10,
  "fallback": "auto"
}
```

城市内找景点时使用 `intent: "discover"`、`q: ""`。本版需提供 WGS84 搜索中心，圆形范围不等于行政边界；可由现有城市索引提供中心，不会暗中增加地理编码请求。分类支持 scenic、accommodation、food、rest、transport；scenic 包括 attraction、heritage、nature、leisure。返回最多 20 条，搜索半径最多 50 km。国内外均可读取现有 OSM 覆盖；当前商业补充仅限已支持的中国大陆范围，境外返回明确的 unsupported_region。

具体地点 `intent: named` 最多返回 1 个最佳合格候选；城市发现默认至少 5 个（受 limit 限制），可以设置 minCandidates。先按范围、类型、已知国家筛选。名称分数至少 0.75，或 embedding 余弦至少 0.65，才允许自动替代；名称完全匹配优先，其余以可用语义分数排序、距离破同分。阈值是当前经验规则，不是身份概率。相同名称、相距 100 米内的候选在本次列表分组，标为 possibleDuplicateIds；不写入实体合并关系，也不保证它们确实是同一实体。

具体名称未匹配且启用 embedding 时，先按相同范围/类别从 OSM 召回最多 60 个附近地点，分批计算语义相似度。本地候选仍不足时，高德最多补充一页 25 条；不翻页、不自动重试、不调用 LLM，也不做两两算路。整个过程共用已有预算台账。高德原始数据不写入 OSM 底库或 OSM 快照；返回 `request_only`。缺少补充权限或超预算时保留本地结果。

## 返回结构与含义

外层 `candidate-search/1`：

| 字段 | 用途 |
| --- | --- |
| status | ready、partial、empty |
| items | `place-candidate/1` 地点候选数组 |
| sufficiency | 本地可用数量、最低数量、是否足够、不足原因、规则版本；scope 固定 search_only |
| local | 云端 live、恢复快照 snapshot 或不可用状态 |
| fallback | 是否尝试高德、次数、结果；最多一次 |
| attribution / assembledAt | 来源署名与响应组装时间 |

`ready` 只表示本次检索足够；不代表事实完整、名称身份或入口已核验。`selection.originalQuery/resolvedName` 保留原请求和替代名。原始 OSM 名称、别名及实体关系不因自动选中而改写。发现列表仍可返回多个地点，具体名称只返回一个。

可选输入 `city: "衢州"` 只为名称向量提供城市语境，不替代经纬度范围约束。模型前先过滤类别、距离和已知国家；一个阶段最多计算 25 个候选，其他候选仍按原名称规则处理。最终分数为 `0.55 × 余弦 + 0.30 × 名称分数 + 0.15 × exp(-距离米/3000)`，这是当前小样本的启发式排序，尚未标定通用阈值。只启用一个推理任务；忙、模型缺失或超时均回退到原排序。

每个地点统一分为：

| 字段 | 内容 |
| --- | --- |
| id / name / aliases | 来源 ID、名称、别名；不用名称充当主键 |
| classification | 分类、细分类型、映射规则版本 |
| location | WGS84 点、点的角色、行政信息、地址；未知值保留 null |
| facts | 开放时间、最后入园、预约、收费描述、门票、游玩时长、通行、官网、电话、无障碍、入住/退房时间 |
| sources | 来源 ID、供应商、URL、许可、数据快照时间、读取时间、保存范围 |
| quality | 检索是否可用、按类别列出的缺失资料、待核验事项；scheduleReady 当前始终 not_evaluated |
| routingHint | 高德结果保留原始 GCJ02 算路坐标；OSM 为 null |
| delivery / match | 实时或缓存、组装时间、距离、名称分数、名称是否需要确认 |

事实格式包含 `value/status/sourceRef/retrievedAt/sourceUpdatedAt/verifiedAt/validFrom/validThrough`。未核对的有效期为 null；整批 OSM 的 PBF 日期只放入 sources.snapshotAt，不冒充每个事实的更新时间。高德 WGS84 坐标是近似转换，算路提示保留原始 GCJ02；两家来源均不默认视为已核验入口。OSM 原始 fee=90 或高德人均消费都不直接变成 90 元门票。

完整真实 OSM 样例见 `validation/candidate-osm-example-20261011.json`。更全面的 `contracts/place-v1.ts` 仍是设计草案；本次上线的是较小的候选结构，没有宣称完整 PlaceV1 的冲突消解、分类扩展及有效期计算已实现。`amap:` 候选 ID 不在原 `/api/routes` 的 ID 解析范围，本版仅输出数据与 routingHint；下一步连接行程/算路时再接入受控候选选择，不在本轮增加新的持久存储。

## 实际数据库结构

服务器为已有 PostgreSQL + PostGIS OSM 库。此前验收的活动提取区合计 4,567,502 行，按 OSM ID 去重后 4,566,067 条；这个数量包含多类设施，不等于同样数量的旅游景点。

| 表或视图 | 实际存储内容 |
| --- | --- |
| osm.imports | 导入批次 UUID、区域、PBF SHA-256、快照时间、入库时间、行数、manifest JSONB |
| osm.active_imports | 每个提取区域当前使用的批次；切换快照不覆盖旧批次 |
| osm.poi | 地点主体；主键为 (import_id, id)，id 是 osm:node/way/relation 编号 |
| osm.current_poi | 活动批次按 OSM ID 去重的视图；不是另一份完整复制 |
| osm.editorial_aliases | 地点 ID、补充别名、语言、来源名/URL、记录时间 |
| osm.place_facts | 一条记录对应一个地点的一个字段：value JSONB、来源、来源时间、记录时间、历史核验时间、evidence JSONB |

`osm.poi` 主体字段包括 name、aliases、category、subcategory、lat/lon、geometry_kind、coordinate_role、country_code/province/city、opening_hours/fee/access、selectable、tags JSONB、search_text。另有 PostGIS 的 geography(Point,4326)、GiST 空间索引、名称三元组 GIN 和中文二字 name_pairs GIN 索引。

本机另有业务库，保存账号、旅行、帖子和 api_usage 等；其中旧 `places` 表是城市索引和示例行程地点，不是云端 456 万条 OSM 地点表。旧表的默认游玩时长和费用不能作为新地点事实来源，本次候选接口没有使用这些默认值。

当前资料表已能按字段补录并保留来源，evidence 保存原文引文、页面 SHA256、官网发布日期及其精度、真实采集时间、适用日期、复核期限、模型、审核状态及批次号。`reviewAfter` 是本系统设定的 24 小时复核期限，不是官网承诺的有效期；官网未声明适用区间时 validFrom/validThrough 保留 null。查询时期限届满返回 value=null、status=needs_review；本机缓存也重新检查期限，历史值留在资料表中。暂未实现自动定时重采集和完整多来源冲突裁决；读取仍按每字段最新记录，evidence_reviewed 表示本次核对过原文，不保证未来临时变更。

## LLM 适合怎样补充资料

可以补充，但应由独立的资料补全服务执行以下流程，而不在地点检索中临时让模型猜事实：

1. 只处理用户实际选中的地点，优先补开放时间、最后入园、预约、门票。
2. 后端取得官网/官方公告等证据，记录 URL、采集时间、原文片段和适用日期；模型不能自行编造 URL。
3. DeepSeek 仅根据提供的证据提取 JSON，返回字段、值、证据编号及原文位置。后端验证证据确实存在、地点主体一致、类型正确和适用日期；语义正确性仍可能需要人工核对。
4. 写入独立资料补充层，保留未知和冲突。模型建议的游玩时长标为 estimated，不冒充景点公布的事实。
5. 使用资料时检查有效期；过期标记待复查，必要时重新采集。检索日期新不等于内容适用于当前出游日期。

本次已跑通 3 个地点的受控补充：人工选定并采集官方页面 → DeepSeek 提取 → 类型、引文连续存在性及日期检查 → Codex 对照原文辅助编辑核对 → 独立资料表追加 → 只读接口验收。没有把模型记忆当作外部证据，也没有接入自动全网爬虫。一次苏博预约引文被模型拼接，校验拒绝；复核后缩小摘要范围并恢复连续原文，修正前后记录保留在 validation/evidence-review-20261011.json。高德商业字段不参与此次入库。

| 地点 | OSM 主键 | 新增资料 | 官方来源 |
| --- | --- | --- | --- |
| 拙政园 | osm:way/468359738 | 季节开放时间、最后检票、淡旺季参考门票 | [园林局开放时间](https://ylj.suzhou.gov.cn/szsylj/kfsj/wztt.shtml)、[园林局门票价格](https://ylj.suzhou.gov.cn/szsylj/mpjg/wztt.shtml) |
| 留园 | osm:way/420034522 | 季节开放时间、最后检票、淡旺季参考门票 | 同上 |
| 苏州博物馆本馆 | osm:way/542534202 | 开放时间、最后入馆、普通观众预约、咨询电话 | [本馆开放服务指南](https://www.szmuseum.com/News/Index/OpenGuide) |

以上页面实际采集于 2026-10-11；原页面标注的发布时间分别为 2025-01-09、2024-07-11、2025-01-08，不能把采集日当成规则更新日。2026 年园林提前开园通知仅适用 6 月 19 日至 10 月 7 日，本批不作为当前规则入库。资料范围是取得的官方常规规则，出行前仍需核查新公告与实时余票；苏博门票价未从该指南找到依据，继续留空。

已入库文件：`data/editorial/official-three-20261011.json`（3 个地点、10 条事实）。云端入库时间 2026-10-11 17:45:49 CST；资料备份 `/home/ubuntu/seatraces-osm/backups/editorial-20261011T094549323252Z.json`，读服务代码备份 `reader-20261011T094549Z.py`。仅新增 evidence 列和本批事实，未覆盖 OSM 主表、未新增访问凭据、未开放公网数据库。

模块职责：`prepare-evidence-bundle.py` 限定来源摘录；`extract-place-evidence.mjs` 调用有预算门控的 DeepSeek；`server/services/evidence-extraction.mjs` 验证提取；`review-evidence-20261011.mjs` 是本批逐项复核后的修正脚本，不能充当通用自动审批；`scripts/osm/import_annotations.py` 校验、备份并事务写入；`place_service.py` 只读并检查时效。抓取原文和模型草稿放在 `.runtime`，公开事实与必要证据在独立资料文件中。DeepSeek 的工具调用仍须由应用执行真实工具，见[官方文档](https://api-docs.deepseek.com/zh-cn/guides/tool_calls/)。

## 本地模型与本轮有限验收

采用 [BGE small zh v1.5](https://huggingface.co/BAAI/bge-small-zh-v1.5) 的 [Xenova ONNX 量化版](https://huggingface.co/Xenova/bge-small-zh-v1.5)，固定 revision `75c43b069aac4d136ba6bc1122f995fedcfd2781`，q8、512 维、CLS pooling、归一化、CPU 2 线程。全部模型文件共 24,451,175 字节，约 24.45 MB；只部署在本机后端，没有为云端 456 万条记录预计算向量或增加向量数据库。

安装依赖后运行 `node scripts/prepare-embedding.mjs` 下载并核对固定 SHA256，再在 `.env` 设置 `EMBEDDING_ENABLED=true` 并重启。本机已完成；运行时禁用远程模型加载，商业 POI 向量只留在当前请求内。`server/integrations/embedding.mjs` 只负责推理，`semantic-ranking.mjs` 只负责计算和排序，原候选服务负责地理/分类过滤与调用降级。

固定公开名称样本：以“衢州孔庙”为查询，完整名称“衢州古城文化旅游区孔氏南宗家庙”余弦约 0.810，简称“孔氏南宗家庙”约 0.661，水亭门约 0.583。公交站约 0.834、外市曲阜孔庙约 0.746，必须先按类型/范围排除。量化批处理分数会有小幅波动，不宜把小数精度当作可靠性。早期版本曾返回 2 个待选择候选并调用一次高德；该行为已被下述单候选策略替代，旧报告仅作历史记录。

本轮 9 项针对性 Node 检查通过；Python 校验了 10 条资料结构和到期降级。云端真实读回三地点分别 103/62/64 ms，10 个字段值、证据哈希、发布日期和采集时间均一致。报告：`validation/embedding-20261011.json`、`candidate-live-20261011-quzhou_named.json`、`evidence-cloud-readback-20261011.json`；统一结构真实例子：`enriched-place-example-20261011.json`。未做压测、全量召回评估、模拟器或 UI 测试。本轮 DeepSeek 实际调用共 6 次（一次修正过程），高德 1 次，本地预算预留增加 0.70 元，不代表供应商账单。

## 历史有限验收（策略调整前）

| 样本 | 结果 | 来源 | 单次端到端耗时 |
| --- | --- | --- | --- |
| 苏州拙政园 | 1 个候选 | OSM，无高德请求 | 242 ms |
| 上海外滩 | 2 个候选 | OSM，无高德请求 | 351 ms |
| 景德镇中国陶瓷博物馆 | 2 个候选 | 高德补充一次 | 426 ms |
| 潮州广济桥 | 1 个候选 | 高德补充一次 | 408 ms |
| 衢州孔庙 | 1 个待确认名称的候选 | 高德补充一次；修复后复查 | 406 ms |
| 衢州周边景点 | 返回 10 个候选 | OSM，无高德请求 | 327 ms |

首次衢州简称筛选失败的报告保留，修复后只复查该项。耗时包含本机后端、已有云端只读连接和必要的供应商请求，是单次样本，不是并发性能保证。类别、地域及别名覆盖不因这六例而视为完整。

新增 5 个轻量行为测试；首次连同既有供应商边界共 15 项通过，简称修复后只重跑新增 5 项。未做全量压测、界面或模拟器验收。调用含一次诊断共预留预算 0.50 元（2.10 → 2.60），不是高德实际账单。临时测试账号均已清理。结果见 `validation/candidate-acceptance-20261011.json`。

可复现命令（会产生有限外部请求，无需重复运行）：

```powershell
node scripts/check-candidates.mjs --live
# 只复查一个样本
node scripts/check-candidates.mjs --live --sample=quzhou_named
```


## 2026-10-11 策略修复与当前验收

| 责任 | 实现位置与行为 |
| --- | --- |
| 游玩点 | `planner.mjs` 仅排 attraction / heritage / nature / leisure，不自动选第一家酒店作锚点。缺失开放时间不再假设 09:00–18:00，相关停留标成草案。 |
| 附近食宿 | `GET /api/catalog/nearby?lat=31.324&lng=120.624&radius=3000&limit=5`，仅返回 accommodation、food 两组。资料不全不挡推荐，分组失败独立处理，不调用地图或 LLM。示例行程停留卡增加“附近食宿”。 |
| 官方资料 | `place_policy.py` 在已核对资料中按适用期、原始发布日期选版本，保留各版本，不用较晚入库日覆盖较新发布信息；到期资料不恢复旧规则冒充当前。 |
| 开放时段 | `official-opening.mjs` 使用小范围、明确语法解析当前三地点的官方季节/每周规则。官方无法解析或过期时不偷偷回退旧 OSM。节假日/临时公告未核实时，返回 regularIntervals 常规参考，intervals 留空，canConstrainSchedule=false。 |
| 字段规则 | 名称去空白并从原始名称标签补回；已知中英泰文国名及一致的分号写法规范到国家码。未知代码保留原值，不猜。fee 仅接受 yes/no/donation；旧 `fee=90` 留在 rawValue，不当作门票价。 |
| 页面 | 空字段、过期资料及“待补充”行隐藏；官方门票展示淡旺季范围；不显示 hasMore，也不把已返回数量当作数据库总数。 |
| 坐标 | 保留 pointRole，代表点仅作选点/聚类参考。地图匹配与路线选择继续使用独立的供应商坐标/短期 token；未做入口现场核验，不改写 OSM 几何。 |
| 查询性能 | 附近检索先取 120–480 个候选再去重和按椭球距离排列；该查询事务内禁用误选的 bitmap scan，使 GiST KNN 生效。关键词搜索保留原计划。并发繁忙 429，SQL 超时 504，连接/服务故障 503。 |

KNN 的 geography 排序按球面距离，最终候选池内用 ST_Distance 排序；这是有限候选检索，不保证全椭球距离精确 top-k，更不是道路最短路。技术依据：[PostGIS 3.5 KNN 运算符文档](https://www.postgis.net/docs/manual-3.5/en/geometry_distance_knn.html)。现有数据最多 8 个活跃提取区，保留跨区 ID 去重。没有调大全局超时、重建 456 万条数据或新增访问凭据。

实测：衢州孔庙 → 孔氏南宗家庙，附近召回 46 个候选，语义分数 0.825341，唯一输出，约 1.17 秒，零高德请求。此前失败的东京景点/交通、台北景点，共 9 次 HTTP 验证全部 live / 200，134–221 ms；这组数据是预热后的有限复查，不是冷缓存或并发性能保证。三处官方开放时段正确采用季节/每周常规规则，园林 11 月常规闭园为 17:00。附近食宿两组各返回 5 个，约 634 ms。

验证文件：`validation/place-policy-live-20261011.json`、`place-policy-local-20261011.json`（80 项 Node 测试、独立数据库已清理）、`地点策略修复验收-20261011.html`。云端发布前已备份；原始 OSM 行和 10 条官方资料内容未重写。未重新爬取官网、调用商业模型或进行压力测试。
