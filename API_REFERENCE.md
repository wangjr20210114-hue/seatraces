# SeaTraces 端到端功能接口

本文件描述当前代码的 HTTP 业务边界、输入、输出和持久化行为。用于前后端联调、测试及后续工具调用设计。接口是否已部署，以部署版本为准；新增吃住接口需要先执行 `server/trip-services-schema.sql`。本次不实现 agent 调度或图片生成。

## 约定

- 云端同源入口：`https://trip.seatraces.com`，业务接口前缀 `/api`。本地前端默认 8788，后端 8787。代理转发 Cookie，不将数据库暴露到公网。
- JSON 请求使用 `Content-Type: application/json`；所有写请求（POST、PUT、PATCH、DELETE）必须带 `X-Seatraces: 1`。跨站写请求拒绝。
- 登录使用服务端 `st_session` Cookie。生产环境 HttpOnly、Secure、SameSite=Strict，14 天有效；浏览器同源携带，其他客户端维护 Cookie jar。密钥、用户密码和 Cookie 不写入日志或接口文档。
- 除健康检查、`GET /me`、认证配置、注册/登录/退出及找回/重设/验证邮箱接口，均须登录。自己的行程、问卷和 CityWalk 通过当前会话确认归属，不接受客户端指定 `userId`。
- `:id` 表示路径参数，含 `/`、`:` 的地点 ID 用 `encodeURIComponent` 编码。行程、会话、草稿、帖子、用户 ID 为 UUID；OSM ID 为 `osm:node/123`、`osm:way/123`、`osm:relation/123`。城市 ID 是 `/places?category=city` 返回的字符串。
- `day` 从 0 开始，UI 中 Day 1 对应 `day=0`。日期 `YYYY-MM-DD`，默认时区按城市处理。地点坐标统一 WGS84，`lat` 纬度 −90…90，`lng` 经度 −180…180；转高德时由地图适配层转换。
- 下表参数中的 `?` 表示可选；省略可选字段可使用默认值。GET 参数放 query；其他参数放 JSON body，另有说明除外。成功默认 200，异步准备可返回 202，创建行程/会话/帖子部分接口为 201。
- 错误通常为 `{error, code?, details?}`；400 参数无效，401 未登录，403 来源/权限不符，404 不存在或非本人资源，409 版本/候选冲突，410 草稿过期，429 频率/预算限制，503 服务不可用，504 地点查询超时。`details` 为 `{path,message}[]`。吃住某组不可用可在 HTTP 200 内返回 `status: unavailable`，不能把它当作“附近没有商家”。
- 版本写入采用 `version` 乐观锁。409 时重新 GET 最新行程并让用户重新确认，不自动覆盖其他页面的修改。接口未承诺统一重试幂等性；下文注明可重试的操作才按相应规则处理。
- 当前多数接口直接返回业务对象或数组，没有统一的 `{data:...}` 包装；不要凭空补包装。

## 主要返回结构

| 结构 | 字段与含义 |
|---|---|
| User | `id,username,nickname,avatar,avatarUrl,email,emailVerified,role,preferences`；不含密码散列。`preferences={interests,pace}` |
| Trip | `id,user_id,title,request,plan,version,status,created_at,updated_at`。`status=planned/completed` |
| JourneyPlan | `schemaVersion:"journey/2",cities,days,generatedAt` 及规划解释/警告；`days[]` 含 `date,city,cityId,timezone,stops,timeBudget,transferAllowance` 等。`stops[]` 保存地点 ID、名称、WGS84 坐标、预计到离时间及地点来源。新字段 `services` 保存吃住选择 |
| PlaceCandidate | `schemaVersion:"place-candidate/1",id,name,aliases,classification,location,facts,sources,quality,delivery`，可含 `parentId,hierarchyLevel,geometricHierarchy,entityIdentity,possibleDuplicateIds,sourceRecords` |
| classification / location | `{category,subcategory}`；`{point:{lat,lng,crs},pointRole,countryCode,province,city,address,adminStatus}` |
| facts | `openingHours,lastEntry,reservation,fee,ticketPrice,stayMinutes,access,website,phone,wheelchair,checkIn,checkOut`；每项为 `{value,status,sourceRef,retrievedAt,sourceUpdatedAt,verifiedAt,validFrom,validThrough,...}`。可能有 `evidence,reviewAfter`。未知/过期资料 `value=null`，UI 隐藏，不能补成“免费”“全天开放” |
| sources | `[{id,provider,objectId,url,license,snapshotAt,retrievedAt,persistence}]`；查询时间不等于资料更新时间或官方核验时间 |
| OSM 原始地点 | `/catalog/search` 和 `/catalog/place` 返回地点库结构：`id,name,aliases,category,subcategory,lat,lng,coord_system,country,province,city,source,source_url,license,facts` 等。它不同于 PlaceCandidate；新功能尽量使用规范化候选 |
| ClusterCatalog | `city,clusters,coverage,inventory,parentLookup` 等；聚类含 `id,members,score`，父景点成员可含 `children`。边界使用单独接口，不是商家价格/营业证明 |
| CityWalk | `id,user_id,title,city,stops,cluster_ids,distance_m,version,created_at,updated_at`；摘要只保留 stops 的 `id,name`。距离为几何路线估算 |

业务数据库是 PostgreSQL。`plan`、`request`、候选快照使用 PostgreSQL JSONB 列；这不是用本机 JSON 文件作为用户数据库。地点大库独立使用 PostgreSQL/PostGIS；只读地点服务对业务后端开放。

## 账号与个人资料

实现：`server/auth.mjs`、`server/mail.mjs`。

| 方法与路径（前缀 /api） | 输入 | 输出与职责 |
|---|---|---|
| GET /me | 无 | `{user:User或null,guestAvailable}`，获取会话；未登录不报 401 |
| GET /auth/config | 无 | `{emailEnabled:boolean}`，决定是否启用邮箱流程 |
| POST /auth/register | `username` 3…32 位英文字母/数字/下划线，`password` 至少8字符且不超过72 UTF-8字节，`nickname?` 1…40字符，`claimGuest?:boolean` | `{user}` 并设 Cookie；账号转小写且唯一，重复409。claimGuest仅用于历史体验账号迁移 |
| POST /auth/login | `username,password` 同上 | `{user}` 并设 Cookie；错误凭证401，连续失败限流429 |
| POST /auth/logout | `{}` | `{ok:true}`，撤销当前会话并清 Cookie |
| POST /auth/forgot-password | `email` 合法地址≤254字符 | 202 `{message}`；向已验证邮箱发重设链接，存在与否返回相同文案。SMTP未配503 |
| POST /auth/reset-password | `token` 64位小写十六进制，`password` | `{ok,message}`；一次性令牌验证后改密码、撤销该用户全部会话 |
| POST /auth/email/request | `email,password` 当前密码 | `{message}`；发送绑定验证邮件。须登录，已有验证邮箱409，SMTP未配503 |
| POST /auth/verify-email | `token` 64位小写十六进制 | `{ok,message}`；消费一次性令牌，绑定找回密码邮箱 |
| PATCH /me | `nickname?` 1…40字符；`avatar?` 六个内置头像之一；`preferences?:{interests,pace}` | `{user}`；修改本人资料。interests为下方兴趣枚举数组≤10，pace为relaxed/balanced/full。不能改username |
| PUT /me/avatar | `image` 为 `data:image/(jpeg或png或webp);base64,...`，字符串≤1500000字符 | `{user}`；限静态图、≤1600万像素，裁剪256×256 WebP存数据库 |
| GET /me/avatar | 无，`v` 仅前端版本标记 | 本人 `image/webp` 二进制；没有上传头像404，不缓存私有图 |

内置头像：🌊、🌿、🧭、🌸、🏔️、☀️。兴趣枚举：人文、自然、艺术、美食、园林、建筑、夜景、安静、亲子、街区。

邮箱配置说明在 README 的账号与邮件章节；接口已实现，SMTP未配置时不能声称发信成功。当前不提供更换已验证邮箱、改账号ID或删除账号接口。

## 地点、城市与资料

实现：`server/index.mjs`、`server/contracts/`、`server/services/catalog.mjs`、`place-candidates.mjs`、`nearby-recommendations.mjs`。

| 方法与路径（前缀 /api） | 输入 | 输出与职责 |
|---|---|---|
| GET /regions | `country?` ≤4字符 | 无country返回 `[{country,count}]`；有country返回 `[{province}]` |
| GET /places | `q?`≤100字符，`category?` city/attraction/hotel/hostel/rest/station，`country?`≤4，`province?,city?`≤100 | 本地业务地点数组≤60；城市选择用category=city；不是全量OSM检索 |
| GET /nearby | `lat,lng` | `{place:city或null}`，粗定位附近城市；不是餐厅推荐 |
| GET /catalog/search | `q?`≤120字符，`category?`，`region?` 2…50位小写字母/连字符，`subcategory?` 1…50位小写字母/下划线，`lat?,lng?`成对，`radius?`1…50000默认10000米，`limit?`1…60默认30 | 地点库响应 `{status,items,...}`；至少q有2字符或提供经纬度；别称可命中规范实体；无hasMore |
| GET /catalog/place | `id` OSM ID | 单个原始地点对象；没有404。用于地点详情，含已有资料和层级 |
| GET /catalog/opening | `id` OSM ID，`date` | 指定日期开放解析：状态、规则来源、可解析时间窗/不确定原因；不保证节假日临时公告已覆盖 |
| GET /catalog/site | `id` OSM ID，`category?` 11类之一，`limit?`1…200默认50，`after?` OSM ID | site组织关系和成员分页；site不自动等同经营/游览父子关系 |
| GET /catalog/hierarchy | 同site | 几何包含层级及父/子对象；当前规则最多8层，不代表人工核验归属 |
| GET /catalog/coverage | 无 | 地点库覆盖范围、记录量和状态 |
| GET /catalog/site-coverage | 无 | site构建覆盖/统计 |
| GET /catalog/hierarchy-coverage | 无 | 几何包含构建覆盖/统计 |
| GET /catalog/entity-coverage | 无 | 规范实体及别称去重覆盖/统计 |
| POST /catalog/candidates | `intent?` named/discover默认named，`q?`≤80，`countryCode`2位大写，`city?`≤60，`lat,lng`，`radius?`100…50000默认15000，`category?` scenic/accommodation/food/rest/transport默认scenic，`limit?`1…20默认10，`minCandidates?`1…10且≤limit，`fallback?`auto/never | `candidate-search/1`：`status,items:PlaceCandidate[],query,sufficiency,local,fallback,embedding,spatialRecall,selection,attribution,assembledAt`。named要求q≥2且仅返回最佳候选；discover最多limit条。先自建库；允许时补查高德，可能计费；高德结果仅本次使用，不写入OSM库 |
| GET /catalog/nearby | `lat,lng,radius?`1…10000默认3000，`limit?`1…20默认5 | `{usage,query,groups:{accommodation:{status,items},food:{status,items}},source,automaticItineraryStops:false}`。通用附近查询，不保存行程选择 |

OSM类别共11类：`attraction,heritage,nature,leisure,accommodation,food,rest,transport,shopping,settlement,service`。`scenic`是前4类的检索集合，不是第12个存储类别。子类型保留OSM标签，允许新增，不是固定中文枚举。

`live`表示已从地点服务读取，数据本身仍是已导入的OSM快照；`snapshot`表示业务端查询缓存。它们都不等于实时营业、实时房态。几何包含、site、实体去重、官方资料补充是不同证据，不相互冒充。

## 个性化问卷与行程生成

实现：`server/services/journey-service.mjs`、`journey-draft.mjs`、`city-clusters.mjs`。

| 方法与路径（前缀 /api） | 输入 | 输出与职责 |
|---|---|---|
| GET /journey/cities/:cityId/boundary | 城市ID（1…80字符），须登录，无请求体 | `{city,boundary}`；问卷选城时预览市界，复用现有高德边界缓存。city为自建库城市简要对象，boundary沿用ClusterCatalog的GCJ02结构。未找到城市404；境外或边界不可用按boundary.status返回，不创建问卷、不写数据库 |
| POST /journey/sessions | `origin:{label(1…150),lat?,lng?},cityIds:string[1…5],start,end`，城市不可重复，每个ID≤80 | 201 `{id,cities}`，保存本人问卷会话。天数不少于城市数，结束日不得早于起始日，最多30天 |
| POST /journey/sessions/:id/cities/:cityId | body `{}`；query `async=1` 推荐 | 202 `{status:"loading",retryAfterMs,...}` 或200 ClusterCatalog。相同用户/会话/城市合并进行中的请求；将候选存入会话；按retryAfterMs再查询，禁止紧循环 |
| GET /journey/sessions/:id/cities/:cityId/boundary | 路径参数 | `{boundary,districts}`；districts为聚类ID到区名列表的映射 |
| POST /journey/sessions/:id/wishes | `placeId`1…80，`wanted:boolean` | `{placeId,wanted}`；只能选当前候选，保存“想去”，规划优先考虑 |
| POST /journey/sessions/:id/visits | `placeId`≤80，`visited:boolean` | `{ok}`；历史兼容的用户到访声明。当前问卷不展示“去没去过”选项 |
| POST /journey/sessions/:id/questions | `{}` | `{questions,defaults,source,...}`；基于内部题库/偏好排序，有模型时受结构校验，无模型退回题库，同会话缓存 |
| POST /journey/sessions/:id/generate | `selections:{[cityId]:clusterId[]}`每城≤30；`answers:{interests?:string[]≤10且每项≤20,pace?,transport?,crowd?,revisit?}` | Trip，保存行程与版本1。模型只能从候选池选点，后端预算/排序/日期规则再处理。同session已生成则返回原行程，避免重复生成 |
| POST /journey/trips/:id/presence | `samples`6…16条 `{lat,lng,accuracy:(0,10000],at:毫秒时间戳}` | `{observations}`；只对旅行当天计划点推断停留，保存到访信号，不宣称用户确认到访 |
| POST /journey/trips/:id/days/:day/route | `{}`，day0…29 | `{status,legs,timing,warnings,checkedAt,...}`；真实地图分段路线，依赖供应商配置/额度，可能部分失败；同版本同天缓存15分钟 |

answers枚举与默认：`pace=relaxed/balanced/full`（balanced）；`transport=balanced/fewTransfers/fewWalking`（balanced）；`crowd=avoid/balanced/lively`（balanced）；`revisit=new/either`（new）；`interests=[]`。

前端总览/每日展示的光滑曲线是示意图，不代表真实道路。总览与每日缩放切换、动画、地图取景、GPS授权属于客户端表现，不必伪造后端接口。

## 行程记录、编辑与版本

| 方法与路径（前缀 /api） | 输入 | 输出与职责 |
|---|---|---|
| GET /trips | `summary=1,limit?`1…100默认11，`offset?`0…1000000默认0 | summary=1返回按创建时间倒序的摘要数组；否则返回按更新时间倒序的完整Trip数组，最多100。历史行程分页应使用summary=1 |
| GET /trips/:id | UUID | 本人的完整Trip，含所有吃住选择；其他用户404 |
| GET /trips/:id/versions | UUID | `[{version,reason,created_at}]`，倒序 |
| PATCH /trips/:id | `version`正整数；以下恰好一个：`status:planned/completed`、`restoreVersion`正整数、`operation` | 最新Trip；事务锁定并创建新版本。restoreVersion恢复整个旧plan（含吃住选择），不是直接回退版本号 |
| POST /trips/:id/assistant | `text`1…500字符，`day`0…29 | `{status:"preview",source,operation,version,preview,message}` 或 `{status:"clarify",message}`；历史简单修改预览接口，不自动保存，也不是本次新增agent |
| GET /questions | 无 | 历史兼容的个性化题库，可能调用模型；新问卷用sessions/:id/questions |
| POST /trips | `origin`1…150字符串，`cityIds`1…8个ID，`start,end,interests?,pace?,transport?` | 201 Trip；旧版规则规划入口，当前卡通问卷使用journey接口，不应混用。旧版plan不能直接使用新增吃住模块 |

operation：`{type:lock/remove/replace/add/move,day:0…29,placeId?:≤80,newPlaceId?:≤80,to?:0…20}`。replace/add的候选目前来自业务places表；该旧编辑入口不是全OSM自由编辑器。完整行程展示以GET结果为准。

## 沿途餐饮和住宿

实现：`server/domain/trip-services.mjs`负责位置/评分，`server/services/trip-services.mjs`负责鉴权、候选缓存、预览和保存；`public/trip-services.js`负责入口和请求复用，`public/service-map-dock.js`负责共享地图中的候选卡片与抽屉操作。只按距离排列，不获取或展示价格，无图片生成、无订餐订房。

| 方法与路径（前缀 /api） | 输入 | 输出与职责 |
|---|---|---|
| GET /journey/trips/:id/services | UUID | `{tripId,version,days:[{day,date,city,slots}]}`，纯读已存行程；不请求地点库 |
| POST /journey/trips/:id/services/recommendations | `{day:0…29,radius?:500…10000,groupMeals?:boolean,activeSlot?:string,sort?:"comprehensive"/"distance"/"price",refresh?:boolean,excludePlaceIds?:string[0…200]}`，未知字段拒绝 | `{tripId,version,day,slots,automaticSelection:false}`；根据行程位置查OSM。默认餐饮1500米、住宿3000米，每组最多5个，候选在PG缓存6小时 |
| POST /journey/trips/:id/services/:slot/preview | `{version:正整数,recommendationId:UUID,placeId:1…200字符串}` | `{tripId,version,slot,candidate,effect:{type:"nearby_choice",affectedDays,scenicOrderChanged:false,reservationMade:false}}`；验证候选真实来自本人行程、当前范围和未过期推荐，不保存 |
| PUT /journey/trips/:id/services/:slot | 同preview | `{trip,services}`；服务端从候选取详情，写入Trip.plan.services并增加版本；不接受用户伪造地点名称/坐标 |
| DELETE /journey/trips/:id/services/:slot | `{version:正整数}` | `{trip,services}`；移除该位置选择，增加版本，历史版本仍保留 |

slot格式：`dining:0`、`stay:0-2`；兼容旧 `lunch:0`、`dinner:0`。前端传 `groupMeals:true` 返回餐饮+住宿两组，旧调用不传该参数仍返回三组。住宿按连续同城日分组；中途去其他城市再回来属于另一组。一天无有效景点坐标时返回空slots，不编造推荐中心。

Slot结构：`id,kind(dining/lunch/dinner/stay),title,anchor,next,days,radius,city,date,fromDate,toDate,scopeKey,selected`。anchor/next是WGS84景点简要对象，days是0起始日期索引；fromDate/toDate描述同城行程范围，**不是已经预订的入住/退房日期**。selected为 `{slotId,kind,days,scopeKey,selectedAt,candidate,reviewNeeded}` 或null。行程改变导致scopeKey不同，旧选择标记reviewNeeded，须重新确认。

推荐时Slot额外包含 `status(live/snapshot/unavailable),items,recommendationId?,queriedAt?,sourceCachedAt?,cached?,code?,message?`。items是PlaceCandidate加 `lat,lng,country,mainlandCityVerified,distanceMeters,extraStraightLineMeters,distanceKind:"straight_line",rankCost,reason`。recommendationId只能用于本行程/本slot；跨用户、已过期或范围变化返回409。

推荐规则：

1. 餐饮以当天全部景点为范围，最多选4个分散的真实景点进行OSM只读检索，每处40条；按离最近景点的直线距离计算位置。住宿以连续同城日景点的medoid为中心。不是按午晚餐营业时间筛选。
2. 候选按ID去重；同名且80米内合并为一个备选。排除无名/无坐标/错类别及明确的咖啡、酒吧、酒馆和冰淇淋。
3. 每批最多5家。优先店间距餐饮300米、住宿500米；数据密集或稀少时逐级放宽，绝不复制凑数。`refresh:true`随机换批，`excludePlaceIds`优先排除已展示项；不足5个新项才复用。返回 `canRefresh,candidateCount`。
4. 统一餐饮推荐固定按 `distanceMeters` 升序排列（同分按ID），返回 `sort:"distance"`。为兼容旧客户端，`sort:"price"/"comprehensive"`仍接受，但使用距离排序，不触发价格查询。旧午晚餐slot和HTTP路径保留。
5. `activeSlot`只限定本次换批类别；`refresh:true`从已缓存候选随机抽取，再按距离排列。维持每批5家及空间分散策略，不保证这5家是全库绝对最近的5家。
6. 推荐、换批、预览、保存均不调用价格供应商。已有 `place_service_prices` 和历史行程中的可选price字段保留，不显示、不新写，不做破坏性迁移。
7. 点击卡片/标记后地图聚焦该地点，卡片下方抽屉展开“选这家 / 高德查看”；旧details深链接回到共享地图，候选在本批时自动选中。高德查看使用 [AMap marker URI](https://developer.amap.com/api/uri-api/guide/mobile-web/point)，携带地点名称、坐标及对应坐标系，不携带用户资料或调用商家详情收费接口。设备可打开高德客户端，否则显示网页。
8. `recommendationId`代表当前有效候选池；选店仍调用原preview和PUT，做所有权、版本、有效期校验。历史午晚餐选择仍可见、可移除，新选择存 `dining:n`。换批等待显示旋转图标及列表呼吸效果，禁止重复提交；失败保留原批次，可重试。减少动态效果的系统偏好会停用动画。

新增表 `trip_service_recommendations`：`id,trip_id,slot_id,scope_key,radius,payload,created_at,expires_at`；唯一键为trip_id+slot_id+scope_key+radius。过期缓存按该行程后续成功查询时清理。选择存入 `trips.plan.services`，同时写 `trip_versions`。不得让agent或客户端绕过预览/版本检查直接写表。

新增表 `place_service_prices`：`place_id`（OSM主地点ID主键）、`fingerprint`（名称/坐标/类别摘要）、`payload`（价格与匹配来源）、`checked_at`、`expires_at`。此表保留历史缓存，当前吃住流程已停用价格查询，不再读取或新增价格记录。

## CityWalk

| 方法与路径（前缀 /api） | 输入 | 输出与职责 |
|---|---|---|
| GET /citywalk/catalog/:cityId | 城市ID≤80 | 202loading或200`{...ClusterCatalog,draftId}`；从真实候选生成本人编辑草稿 |
| GET /citywalks | `limit?`1…50默认10，`offset?`≥0默认0 | 本人路线摘要数组，按updated_at倒序 |
| GET /citywalks/:id | UUID | 本人完整CityWalk |
| POST /citywalks | `id:UUID,draftId:UUID,title:1…80,clusterIds:字符串[1…50],stopIds:字符串[2…100],startId:字符串,version?`；成员ID≤200 | CityWalk，保存服务端候选快照和短路径顺序；同id重试返回本人原记录；过期草稿410 |
| PUT /citywalks/:id | 同POST，body.id必须等于路径id且version必填 | 更新CityWalk，版本+1；旧版本409 |

经典CityWalk当前为 `public/citywalk-classics.js` 的只读编辑选题（由静态文件接口 `GET /citywalk-classics.js` 提供），不是数据库内的已保存路线。打开后仍通过真实城市候选解析名称；无法唯一匹配时由用户选择，不编造坐标。收藏成自己的路线使用同一个POST /citywalks。未来若需要运营后台，再将经典路线迁移为业务表/JSON接口。

## 地图、导航与跨城交通

| 方法与路径（前缀 /api） | 输入 | 输出与职责 |
|---|---|---|
| GET /maps/config | 无 | `{enabled,jsKey}`；仅前端公开JS Key，安全密钥留服务端 |
| GET /maps/google/config | 无 | `{enabled,jsKey}`；境外地图配置，未开通则disabled |
| GET /_AMapService/v4/map/styles | SDK query字符串，每值<2000字符 | 高德原始样式响应；服务端覆盖key/jscode。兼容路径 `/_AMapService/v4/map/styles` 同样须登录。固定目标，不是任意URL代理 |
| POST /places/:id/match | `{}` | 地图候选匹配结果 `items`，可含短期 `matchToken`；供用户选择地图端点，不覆盖自建库来源信息 |
| POST /routes | `from,to` 地点ID≤80，`strategy?`balanced/fewTransfers/fewWalking/fastest，`mode?`walking/transit/driving/cycling，`departure?`YYYY-MM-DDTHH:mm，`departureTimeZone?`≤100，`fromMatchToken?,toMatchToken?`≤2048 | 供应商统一路线结果：状态、候选方案、分段/步骤、来源，可含`endpointSelections,selectionNotice`；缺配置/配额时按状态报错或明确估算，不当作实时导航 |
| POST /transport | `type:train/flight,from:1…50,to:1…50,date` | 已配置适配器的查询结果，未配置明确返回不可用；不订票、不保证实时票价已接入 |

跳转高德导航由客户端根据选定端点生成URI，不新增付费后端调用。分段导航/宏观曲线各自使用对应结果；曲线不替代真实转乘步骤。吃住详情仅对已确认中国大陆范围开放高德跳转。

## 发现、收藏、浏览与报告

以下后端接口已存在；当前“发现”、收藏/浏览/报告页面仍有空壳内容，不能把后端接口存在等同于所有页面已接通。本次聚焦吃住。

| 方法与路径（前缀 /api） | 输入 | 输出与职责 |
|---|---|---|
| POST /posts | `tripId:UUID,title:1…100,body:1…4000` | 201帖子对象；只能分享本人行程，保存景点快照；每个行程重复发布409。快照不含私有吃住选择 |
| GET /posts | 无 | 推荐帖子数组，最多读取最新200条再排序；含`nickname,avatar,likes,saves,comments,mine,score,reason`；mine是本人like/save/recommend数组 |
| GET /posts/:id/comments | 帖子UUID | `[{id,body,created_at,nickname,avatar}]` 最多100条，倒序 |
| POST /posts/:id/comments | `body`1…500 | `{ok}`，保存本人评论 |
| POST /posts/:id/reactions | `kind:like/save/recommend,active:boolean` | `{ok}`，置为指定状态，重复操作幂等 |
| POST /posts/:id/view | `seconds`整数0…120 | `{recorded:true}`，按本人+帖子+天累计停留，最多120秒/天；用于推荐权重 |
| GET /me/history | 无 | 浏览历史数组≤100：`created_at,dwell_seconds,id,title,tags`；不是旅行历史 |
| DELETE /me/history | `{}` | `{ok}`，只清本人浏览记录，不能删除已存旅行 |
| GET /me/report | 无 | `{completed,planned,cities,stops,interests,summary,source}`；基于本人历史和偏好，不编造实际到访 |

目前没有独立的全量收藏分页接口；GET /posts 中 `mine` 包含save只覆盖该返回窗口。后续完成收藏页面时应补专门分页查询，不应把这个窗口宣传为全部收藏。

## 管理与运维

| 方法与路径 | 输入 | 输出与职责 |
|---|---|---|
| GET /api/health | 无 | `{ok,database,version}`，检查业务数据库连接；不代表地图/模型/地点服务均可用 |
| GET /api/status | 无，须登录 | `{providers,counts,database,spatial,budget,demo}`；budget是请求预留估算，不是供应商账单 |
| GET /frontend-health | 无，前端服务端口 | 前端独立存活信息；后端停机时仍应能显示页面 |
| POST /api/admin/places/import | PlaceImport数组1…500，须admin | `{imported}`；事务写业务places、import_jobs、audit_log，不是全量OSM导入 |

PlaceImport必填：`id`字母数字下划线连字符1…80，`name`1…200，`category`业务6类，`country`2位大写，`city`1…100，`lat,lng,source`1…200，`license`1…200，`data_status`demo/reference/verified。可选：`aliases`≤30且各≤200，`province`≤100，`timezone`≤100，`tags`≤20且各≤20，`description`≤2000，`duration_min`0…1440整数，`cost`0…1000000，`currency`3位大写，`source_url`合法URL，`verified_at`ISO时间或null，`hours`为null或`{open,close,lastEntry,closedWeekdays,note?}`（时间HH:mm；周日0…周六6；note≤500）。

OSM导入、边界/site/parent重建、去重和官方证据审核位于 `scripts/osm/` 等维护脚本，不开放到普通用户HTTP接口。程序内部函数不是直接对外的agent工具。

## 可复现的点击和调用流程

### 从新行程到吃住保存

1. 登录页 → POST /auth/login → GET /me，Cookie由浏览器保存。
2. 旅行 → 制订个性化旅行方案 → GET /places选择城市 → POST /journey/sessions。
3. 每城市POST cities?async=1加载聚类；GET boundary画区图；POST wishes保存想去。
4. POST questions → 用户答题 → POST generate → 获得Trip。
5. 选择Day → 页面下方“沿途吃住”自动POST services/recommendations；只推荐，不替用户选。
6. 点击餐饮/住宿 → 独立候选页 → 点击商家 → POST preview进入详情；未知字段不显示。
7. 点击“选作餐饮/住宿” → PUT services/:slot带当前version → 返回首页；从历史行程再次打开GET /trips/:id恢复选择。
8. 不满意可在列表“移除选择”，DELETE带当前version；行程改动后reviewNeeded提示重新确认。

示例（登录后在同源客户端执行；tripId必须是本人真实ID）：

```js
async function call(path, body, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: {'Content-Type': 'application/json', 'X-Seatraces': '1'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
  const result = await r.json();
  if (!r.ok) throw Object.assign(Error(result.error), {status: r.status});
  return result;
}
const rec = await call(`/journey/trips/${tripId}/services/recommendations`, {day: 0});
const lunch = rec.slots.find(s => s.kind === 'lunch');
// UI让用户选择；只有候选非空并收到用户选择后执行以下步骤。
const choice = {version: rec.version, recommendationId: lunch.recommendationId, placeId: selectedPlaceId};
const path = `/journey/trips/${tripId}/services/${encodeURIComponent(lunch.id)}`;
const preview = await call(path + '/preview', choice);
// UI展示preview.candidate，用户确认后保存。
const saved = await call(path, choice, 'PUT');
```

### 验收与边界

- `npm run check` 做语法检查。`TEST_TRIP_SERVICES=1 node --test test/trip-services.test.mjs` 使用本机PG隔离schema验证本人资源、缓存、预览、原子保存、并发旧版本409、跨天住宿共享、移除和过期候选。测试完成清理隔离schema，不改真实行程。
- `node scripts/check-trip-services.mjs` 要求本机预览后端8792与本机PG；创建一次性本机账号验证真实OSM附近查询、保存和恢复，finally删除测试账号。报告写validation目录，不上传用户资料。
- 餐饮住宿本次是地点推荐及行程备选，不含预订、支付、用户评论、实时价格/房态；不做餐厅和旅店概念图。
- 景点概念图和本地缓存为后续功能：建议缓存键为规范景点ID+画风版本，区分概念图和实拍；本次没有生成接口或自动花费。
- 后续agent应复用“查询→预览→确认→带版本保存”的接口顺序，不能把模型输出直接当作可信地点、任意SQL或已生效变更。本次未接入agent工具。

## 共享旅行地图（2026-10-14）

问卷使用首页地图与下方不透明纸签。选中出发地仅使用已有地点坐标；选中目的城市调用新增的 `GET /api/journey/cities/:cityId/boundary`。日期与偏好不触发重复选点查询。片区页继续使用原有 session 城市目录、区县刷新、wishes、questions、generate 接口。地图点与片区卡片共用选择状态。

`#/services/:tripId?day=0&slot=lunch:0` 现在使用同一地图下方的吃住面板；`place` 参数仍打开独立详情页。餐饮、住宿保留当天景点曲线，分别叠加候选位置。点击标记或卡片调用原有 preview，选择才调用原有 PUT，移除调用 DELETE。版本冲突保留错误并提供刷新；不自动重排景点，不把虚线当作实际道路。

地图通信是同源 iframe 的内部视图协议（不是新增业务HTTP接口）：原有 `seatraces-overview`/`seatraces-route` 字段保持兼容，新增可选 `kind,contextKey,services,serviceAnchor,boundary,district,clusters,wishes,focus,selectionFocus`。`selectionFocus:{key,position}`为显式选店聚焦命令，新key才移动相机；不改变候选批次fitKey。问卷地图按聚类坐标范围适配，只有无聚类时才适配行政区边界。聚类数据到达时fitKey变化，迟到边界不会再把聚类缩小；选择/取消片区不改变相机。新上下文首进适配，返回恢复相机；用户移动地图后迟到的边界不会抢走视角。CityWalk继续兼容旧消息格式。坐标从WGS84转换到GCJ02一次，高德边界已为GCJ02直接绘制。

本次只新增上述一个认证只读市界接口，原72个HTTP操作的请求/响应合同与数据库表结构保持不变。地图渲染实现参考[高德 JS API 2.0 地图状态](https://developer.amap.com/api/javascript-api-v2/guide/map/state)。
