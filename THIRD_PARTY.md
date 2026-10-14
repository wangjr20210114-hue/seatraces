# 第三方组件、数据与 AI 使用

- Node.js：运行时，https://nodejs.org/ 。版本在本机构建为 24.19.0。
- PostgreSQL：数据库，https://www.postgresql.org/ 。本机实际 `SELECT version()` 为 18.4。
- `embedded-postgres`：本地开发启动 PostgreSQL 的包装器，MIT；其发行二进制另有各组件许可。生产不使用这个包装器。https://github.com/leinelissen/embedded-postgres
- Express / pg / Zod / Helmet / cookie-parser / bcryptjs / dotenv：许可及准确版本见 `package-lock.json` 与安装包 LICENSE。
- Leaflet：BSD-2-Clause，https://leafletjs.com/ 。
- GeoNames：`cities15000.txt` 与 `admin1CodesASCII.txt`，CC BY 4.0，来源 https://download.geonames.org/export/dump/ ，下载于 2026-10-10。保留署名，修改包括中文别名优先显示、省份中文映射与统一索引。数据为城市/聚居地目录，不是所有国家所有城市，更不是所有旅游 POI。
- OpenStreetMap：© OpenStreetMap contributors，ODbL 1.0，https://www.openstreetmap.org/copyright 。`public/maps/*.geojson` 是通过 Overpass API 获取的城区道路、水系、公园矢量衍生数据库，按 ODbL 1.0 分发，保留其中来源和时间。可在原型服务器 `/maps/` 路径获取这些文件。公开发布时应继续提供这些衍生文件和必要的许可说明。https://opendatacommons.org/licenses/odbl/1-0/
- OSM 公共瓦片在本次环境返回拒绝，原型已停止调用其瓦片端点，改用独立开放数据提取后的本地矢量渲染。不通过镜像、伪造 Referer 或伪造身份绕过瓦片限制。
- 示例景点介绍、页面插画与界面为本项目生成内容；示例数值不代表官方开放与票务信息。
- 鸿蒙 SDK、ArkUI、ArkWeb：按华为 SDK 与开发者协议使用，由用户自行处理软件协议和开发者签名。
- 高德接口参考：https://lbs.amap.com/api/webservice/guide/api/newroute 。密钥和许可待申请；不把商业 API 响应批量存成自有地点库。
- 聚合火车接口：https://www.juhe.cn/docs/api/id/817 。授权与费用待确认。
- Amadeus Flight Offers Search：https://developers.amadeus.com/self-service/category/flights/api-doc/flight-offers-search 。生产覆盖与权限待实测，不承诺覆盖所有中国及国际航司。
- DeepSeek JSON 模式：https://api-docs.deepseek.com/guides/json_mode/ 。模型名通过环境变量配置，2026-10-11 已验收真实 JSON 调用及三景点官方证据提取；引文检查及编辑复核结果随批次保存。
- PostGIS 镜像：https://github.com/postgis/docker-postgis 。尚未部署的旅行应用 Compose 示例使用 `18-3.6`，PostgreSQL 18 数据卷路径为 `/var/lib/postgresql`。
- 独立 OSM 服务实际部署使用 `postgis/postgis:16-3.5` 的固定摘要，PostgreSQL 16.9 / PostGIS 3.5.2，卷路径 `/var/lib/postgresql/data`；与尚未部署的应用 Compose 示例分开。
- 全国 OSM 原始提取来源 Geofabrik：https://download.geofabrik.de/asia/china.html 与 https://download.geofabrik.de/asia/taiwan.html ，快照时间 2026-10-09T20:21:04Z。China 提取包含港澳，Taiwan 单独下载；具体提取边界以来源页面为准。原始 PBF 与命名地点衍生数据库均保留 © OpenStreetMap contributors / ODbL 1.0 声明。处理包括旅游分类、多语言别名、代表点、访问限制和检索索引，不补造缺失事实。原始数据不放入源码 ZIP。公开提供衍生数据库时须保留 ODbL 许可、署名和相应共享要求。
- OSM 处理依赖锁定在 `scripts/osm/requirements.txt`：pyosmium 4.3.1（https://github.com/osmcode/pyosmium）、Shapely 2.1.2（https://github.com/shapely/shapely）、psycopg 3.2.12（https://www.psycopg.org/）；各自许可证随安装包保留。Python 包安装到项目隔离目录，不打包环境或凭据。
- 国外扩库同样采用 Geofabrik 官方区域提取：https://download.geofabrik.de/asia.html 。日本、韩国、泰国、越南、马尔代夫分别提取；马来西亚、新加坡、文莱属于同一官方提取文件。各份文件的准确来源 URL、快照时间和哈希见 `validation/osm-*-source.json` 与 `osm-*-extraction.json`；已入库范围以服务器验收记录为准。数据继续适用 ODbL 1.0，保留原生名称及现有语言别名，不把缺少中文译名的地点自动编造成中文名称。

本次软件架构、源代码、测试、插画和说明由 AI 辅助生成并进行了本地构建及接口/界面验证。比赛提交时应据实披露 AI 工具与使用范围，并由团队审核承担作品责任。DeepSeek 已用于受限结构化处理和资料提取；离线回退仍是本地规则。

- `@huggingface/transformers` 4.3.1：Apache-2.0，https://huggingface.co/docs/transformers.js/index 。BGE-small-zh-v1.5 原模型为 MIT，https://huggingface.co/BAAI/bge-small-zh-v1.5 ；本次使用 Xenova ONNX q8 转换版，固定 revision 与每文件 SHA256 见 `scripts/prepare-embedding.mjs`。权重位于 `.runtime/models`，不随源码压缩包分发。ONNX Runtime、Sharp 等依赖的准确版本和许可保留在 lockfile 与各 npm 包中。
- 三景点补充资料来源苏州市园林和绿化管理局、苏州博物馆官方公开页面。只保存必要事实与核验引文，逐条保留 URL、发布日期、采集时间、哈希和时效说明；不把官网文章全文或高德商业结果混入 OSM 原始快照。

- Google Places API（New）、Routes API 和 Maps JavaScript API：新增默认关闭的可选境外适配。参考 https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes 、https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places/searchText 。Google 数据不混入 OSM 数据库；地图几何只能在对应 Google 地图中显示，保留署名、返回警告及第三方署名。政策见 https://developers.google.com/maps/documentation/routes/policies 与 https://developers.google.com/maps/documentation/places/web-service/policies 。公开上线的服务条款、隐私页面、账号地区资格、计费与网络尚待完成确认，当前未调用实际服务。

- `opening_hours` 3.15.0：以未修改的 npm 模块运行在后端，用于解释自有 OSM 开放时间；锁定版本和完整性校验在 package-lock.json。上游项目 https://github.com/opening-hours/opening_hours.js ，模块声明 LGPL-3.0-only；作者 Dmitry Marakasov、Robin Schneider 和 opening_hours.js contributors。许可文本副本见 `licenses/opening_hours-LGPL-3.0-only.txt`，上游来源、版本及可替换依赖仍保留。未复制其 AGPL 网站评估工具到本项目；前端只使用本项目接口。依赖 `i18next`、`suncalc` 由锁定安装带入，其上游许可证随 npm 包保留。
