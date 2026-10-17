# CityWalk 与个人中心调研及实现

核对日期：2026-10-17。本文描述本次源码实现；线上是否更新以部署版本为准。

## 经典路线的选取方式

选择同一街区内具有辨识度的地标组合，优先密集、连续、短距离的路线。官方介绍用于确认街区与地标关系，OSM/高德用于核对同名地点和坐标，最终逐段调用高德步行接口。没有把全市热门景点强行塞进一条步行路线，也没有将模型生成的地点或距离当作事实。

下表是本次初始数据中的实际步行核验结果，地图可直接显示已存的步行折线；每次打开经典路线不重新调用算路 API。它们是编辑整理的短路线，不声称存在唯一官方标准或全局最短解。

| 城市 | 路线 | 站数 | 步行距离 | 主要地标与依据 |
|---|---|---:|---:|---|
| 上海 | 外滩 · 桥畔万国建筑 | 6 | 1,768 m | 邮政博物馆、乍浦路桥、外白渡桥、黄浦公园、和平饭店、江海关；[上海市政府历史走廊介绍](https://www.shanghai.gov.cn/nw15343/20250710/c756c96e47fb422e844e3336da22ada5.html) |
| 上海 | 武康路 · 梧桐洋房 | 5 | 1,408 m | 武康大楼、黄兴旧居、武康庭、巴金故居外观、话剧艺术中心；[武康路—安福路街区](https://www.shanghai.gov.cn/citywalk/20260625/3492b1b945c146fc96c4585d7b04f00d.html) |
| 上海 | 思南路 · 里弄与花园 | 6 | 2,780 m | 一大会址、新天地、复兴公园、孙中山故居、思南公馆、田子坊；[上海文旅精品线路](https://whlyj.sh.gov.cn/cysc/20250429/bdfdd24977f34d4fa230a93c4bb4b6f5.html) |
| 北京 | 什刹海 · 钟鼓胡同 | 5 | 1,929 m | 钟楼、鼓楼、烟袋斜街、银锭桥、恭王府；[北京旅游网](https://www.visitbeijing.com.cn/article/4Ij8dhfu6Oe) |
| 北京 | 国子监 · 京味书香 | 5 | 3,395 m | 雍和宫、孔庙、国子监、五道营、南锣鼓巷；[北京旅游网街区介绍](https://english.visitbeijing.com.cn/article/4Dm9xoyWuqp) |
| 北京 | 前门 · 老字号与琉璃厂 | 5 | 2,741 m | 正阳门、北京坊、大栅栏、杨梅竹斜街、琉璃厂；[北京旅游网路线](https://s.visitbeijing.com.cn/line/967) |
| 杭州 | 白堤 · 西湖名景 | 7 | 2,530 m | 断桥、锦带桥、平湖秋月、中山公园、楼外楼、西泠印社、西泠桥；[杭州文旅精品线路](https://wgly.hangzhou.gov.cn/module/download/downfile.jsp?classid=0&filename=c3ccb4250d3143a09047ee20fbe1170c.pdf) |
| 杭州 | 清河坊 · 南宋旧街 | 6 | 1,834 m | 吴山广场、胡庆余堂、河坊街、南宋御街、鼓楼、胡雪岩故居；[杭州网文化路线](https://ori.hangzhou.com.cn/ornews/content/2009-09/30/content_2800079.htm) |
| 广州 | 西关 · 荔湾到永庆坊 | 6 | 2,824 m | 荔湾湖、荔湾博物馆、李小龙祖居、永庆坊、粤剧艺术博物馆、上下九；[荔湾区政府](https://www.lw.gov.cn/zzzs/bmdt/content/post_9806699.html) |
| 广州 | 沙面 · 江畔老建筑 | 5 | 1,842 m | 沙面公园、沙面会堂、露德圣母堂、粤海关外观、邮政博览馆；[广州市政府](https://www.gz.gov.cn/zwfw/zxfw/gysy/content/post_2858711.html) |
| 深圳 | 福田 · 城市文化中轴 | 6 | 2,333 m | 关山月美术馆、当代艺术与城市规划馆、深圳博物馆、书城、音乐厅、图书馆；[深圳市政府](https://www.sz.gov.cn/cn/xxgk/zfxxgj/zwdt/content/post_12080423.html) |
| 深圳 | 南头 · 千年古城 | 4 | 1,582 m | 南头古城、古城博物馆、新安县衙、中山公园；[深圳文旅主题路线](https://www.sz.gov.cn/cn/xxgk/zfxxgj/bmdt/content/post_11571456.html)、[古城博物馆介绍](https://www.sz.gov.cn/szzt2010/szwtt/wtcg/whcg/content/post_11132704.html) |

共 12 条、66 个站点。早年街区介绍只作为历史地标关系证据，不用于宣称今天的开放时间。巴金故居、粤海关博物馆按核对时的供应商状态标为“外观”；入馆预约、门票和临时封闭仍需场馆确认。坐标为地点代表位置，不等于已核验入口。

数据在 `server/data/classic-citywalks.json`；检索选题在 `scripts/classic-walk-research.mjs`。保留原有 3 条路线 ID。只升级与旧初始化内容完全一致、未被管理员更新的记录；手动编辑/下架记录保留。因此已有数据库可能保留人工版路线，而非强制替换为本表。

## 选点交互

旧流程每次点选后立即核验高德步行线路，网络、限流和多路段计算会拖慢反馈。本次改为：

1. 点选、移除、调整起点：浏览器立即使用最近邻 + 2-opt 近似排序，以平滑曲线预览，完整保留已选地点。
2. “连线约”只是几何估算。附近候选查询异步执行、220 ms 防抖并缓存，不阻塞连线。
3. 用户点击“规划步行路线”才请求原 `/api/citywalk/preview`。
4. 核验成功后显示真实距离并允许保存；超过 10 km 提醒，达到 15 km 不允许保存。核验失败保留选择并允许重试。
5. 等待期间继续选点会使旧核验失效；旧响应不能覆盖新选择。保存仍由后端重新检查所有权、草稿、版本及真实路线，复用已有路段缓存。

没有新增收费供应商，也没有改变现有 CityWalk HTTP 参数。

## “我的”市场对照与取舍

| 对照产品与资料 | 常见能力 | SeaTraces 本次落地 |
|---|---|---|
| [携程官方产品路径说明](https://rulecenter.ctrip.com/statics/rule/74/latest.html) | 个人资料、历史浏览、旅行足迹、社区记录、账号安全 | 将已有业务的收藏/浏览做成真实列表与详情，补全账号安全入口；保留头像、昵称、消息、历史行程 |
| [Google Maps 保存列表](https://support.google.com/maps/answer/7280933?hl=zh-NR) | 保存、整理、再次查看地点/路线 | 收藏按本人账号读取、支持取消；我的 CityWalk 有独立列表与编辑入口 |
| [TripIt Travel Stats](https://help.tripit.com/en/support/solutions/articles/103000063417/) | 行程、城市等旅行统计 | 行程、CityWalk、收藏、未读概况；旅行手账区分计划、用户标记完成、已有到访记录 |
| [TripIt 账号功能组织](https://www.tripit.com/web/blog/news-culture/whats-new-tripit-app-2022) | 账号、统计、帮助集中入口 | 设置下集中账号安全、旅行偏好、消息、帮助与关于 |
| [Google Maps Timeline](https://support.google.com/maps/answer/6258979) | 实际到访记录可查看与管理 | 只统计已有到访，不把规划中的景点伪装成实际足迹，不新增持续定位 |

新增旅行偏好页：兴趣、节奏、交通、拥挤、重游五个维度，保存到既有 PostgreSQL 智能体记忆，后续规划复用。并发修改以版本冲突保护，不能静默覆盖另一个窗口的新偏好。

新增修改密码与退出其他会话；密码必须再次验证，修改后轮换当前 Cookie 并撤销旧会话和找回令牌。会话数不是设备数。安全操作不开放给智能体代填密码。

暂不加入没有对应业务的订单、钱包、积分、优惠券、会员，也不新增空壳入口。后续可独立规划：反馈工单、通知偏好、个人数据导出/注销、可审核的旅行足迹地图。这些不属于本次已实现功能。

## 数据和验收边界

无数据库结构迁移。复用 trips、citywalks、posts、reactions、browse_events、inbox_messages、user_place_presence/visits、agent memory、sessions 等既有表。个人接口全部登录保护、按账号过滤、分页读取；旅行报告在 PostgreSQL 聚合，不把历史行程全量读进 Node 内存。

接口见 [API_REFERENCE.md](API_REFERENCE.md) 与 [CITYWALK_API.md](CITYWALK_API.md)，可亲自执行的用例见 [CITYWALK_PROFILE_TEST.md](CITYWALK_PROFILE_TEST.md)。
