# 地点资料更新

业务库保存 `official_place_sources`、`official_place_facts`、`official_fact_reviews`、`place_fact_demand`。OSM 仍负责基础身份、几何和分类；业务扩展负责官方资料，不复制整库。

后台“地点质量 → 官方资料”可提交维护任务，查阅原文、逐字证据、采集及复核期限。必须人工核对地点、语义与适用日期后确认。来源页面改动会撤销当前可用状态，过期事实不进入规划。没有可靠值仍然未知。

每任务最多10个已登记页面，近期生成行程用到的地点优先。每页15秒、512KB上限、正文24000字符。拒绝重定向和任意模型URL。首批来源从既有核对资料登记；扩展来源需在服务端明确配置并审核主机，不能由用户提交任意网址。

`OFFICIAL_FACT_AUTO_REFRESH=false` 默认仅手动。设置为 `true` 后，每小时检查近7天有需求且到期的来源，幂等创建 `place_refresh` 维护任务；任务复用现有租约、取消和重试机制。正文不变时复用审核结果，检查日期更新，原始发布日期不伪造为今天。正文变更由 DeepSeek 提取并进入待复核；没有模型配置仍可记录官网采集状态，不能凭空补事实。

字段返回 `factQuality`：`status`、`usable`、`sourceUrl`、`checkedAt`、`reviewAfter`、`validFrom`、`validThrough`。当前只接受既有提取器覆盖的开放、最后入场、参考票价、预约及咨询电话。临时公告要保留官方明确的适用日期；没有完整语义证据时不自动转成闭园或开放结论。

查看接口：`GET /api/admin/places/fact-sources`、`GET /api/admin/places/fact-reviews?state=pending`。复核：`POST /api/admin/places/fact-reviews/:id`，参数 `{version,decision:"accept|reject",confirmation:"review-official-fact"}`。运行任务沿用 `POST /api/admin/maintenance/tasks`，`kind:"place_refresh"`。复核和任务均需对应后台权限，所有接受/拒绝操作写审计。
