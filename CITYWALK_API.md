# CityWalk 路线与步行距离接口（本轮迭代）

## 经典路线

经典路线由 PostgreSQL `classic_citywalks` 管理，轮播从后端读取；点击直接查看地图和站点，不再先进入自建路线问卷。地图使用已核验的高德步行路段折线，坐标为 GCJ-02；地点库存储坐标仍为 WGS84，显示时转换一次。

| 接口 | 参数 | 功能 |
|---|---|---|
| GET `/api/citywalk/classics` | 无 | 已发布经典路线摘要（最多 100 条） |
| GET `/api/citywalk/classics/:id` | slug ID | 站点、官方来源、核验日期、路线折线及实际步行距离 |
| GET `/api/admin/citywalks` | 管理员会话 | 已发布/未发布路线和版本 |
| GET `/api/admin/citywalk/places` | `cityId,q` | 从内部地点库搜索城市附近景点、餐饮和购物地点，不接收任意 URL |
| POST `/api/admin/citywalks` | `id,title,cityId,stopIds[2..20],sources,theme,motif,enabled` | 创建；位置只从服务端地点记录获取 |
| PUT `/api/admin/citywalks/:id` | 同上及 `version` | 乐观锁更新站点顺序和资料；发布前核验实际步行路线 |
| PATCH `/api/admin/citywalks/:id/visibility` | `version,enabled:false` | 下架；历史资料保留 |

来源 `sources` 是 1–5 项 `{title,url,checkedAt}`，URL 仅 HTTPS，服务器不抓取管理员输入的 URL。地图无法核验时可以保存未发布路线，不能发布；达到 15 公里不能发布。客户端不可直接提供距离或路线坐标。发布变更与操作审计同一事务。

`citywalk_route_legs` 按地点 ID、坐标、坐标系、国家及顺序做散列缓存，24 小时有效；并发相同路段合并，失败短暂冷却，所有真实调用仍经过现有预算及限速层。缓存只存路线数据，不含用户身份。只读经典路线不发起付费算路。

## 首批路线依据（2026-10-16 核对）

这是从官网资料选取的相邻短段，不将完整官方游程全部照搬，也不承诺各室内地点实时开放。坐标逐点从既有 OSM 只读库核对；同名桥有多条 OSM 对象时取核对后的同一位置代表对象，不将重复记录当作多站。景点坐标仍是代表点，并非已核验入口。

| 城市 | 选取站点 | 本轮实际步行距离 | 官方依据 |
|---|---|---|---|
| 上海 | 上海邮政博物馆 → 外白渡桥 | 572m | [虹口区北苏州路滨河空间](https://www.shhk.gov.cn/qyfwy/030002/030002002/030002002005/20201217/5e435e0a-fbee-4b96-8dc6-1272a1f58da7.html) |
| 北京 | 烟袋斜街 → 银锭桥 → 恭王府 | 1,040m | [北京市“漫步北京”](https://www.beijing.gov.cn/ywdt/zwzt/gjxxfxcs/yhq/mbbj/index.html) |
| 杭州 | 断桥残雪 → 平湖秋月 → 中山公园 → 楼外楼 | 2,058m | [杭州文旅精品线路，第 1 页](https://wgly.hangzhou.gov.cn/module/download/downfile.jsp?classid=0&filename=c3ccb4250d3143a09047ee20fbe1170c.pdf) |

路线与核验快照在 `server/data/classic-citywalks.json`。启动仅插入缺失的初始路线，绝不覆盖后台编辑或重新启用已下架路线。后续现场封路、开放规则变化需管理员复核更新。

## 距离限制

比较供应商返回的未取整实际米数：`distanceM > 10000` 提醒，`distanceM >= 15000` 阻止。无有效高德步行路段时返回 `status:preview,distanceM:null` 和单独的几何估算，不冒充实际距离。已核验返回 `status:verified,legs,distanceM,durationSeconds,checkedAt,warning,blocked`。这里只对返回的步行备选取最短，不声称证明了整个道路网络的全局最短路线。
