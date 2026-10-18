# 行程天气与官方预警

行程每日视图中的“天气与预警”按需读取。预报复用既有高德 Web 服务 Key，调用仍经过预算和限速；不新增高德凭据。天气使用六位行政 adcode，不把公交的电话区号误用为天气参数。

- `GET /api/journey/trips/:id/weather?day=0`：本人行程；日期索引0–29。返回 `status,forecast,provider,reportedAt,checkedAt,expiresAt,advice,indoorStops`。超出预报范围返回 `outside_forecast_range`，不编造远期天气。室内建议只来自当前行程中已识别的博物馆/展馆，不自动改行程。
- `GET /api/journey/trips/:id/weather-alerts?day=0`：本人行程；当前官方预警与所选日期有交集时显示。没有配置、没有数据和“查询成功但无当前有效预警”分别表示。首版仅对国内城市开放，不把当前预警当作远期预报。
- 预报最多复用1小时且源发布时间超过12小时不再当作有效预报。预警复用最多5分钟，并再次检查有效期；取消/被替代的预警不显示。数据供应商可能延迟，页面保留其归属说明。
- `city_weather_cache`、`city_weather_alerts` 保存公共城市天气，不含用户身份。新迁移文件 `server/weather-schema.sql`，生产上线前备份并执行。并发同城合并，最多32个进行中请求，不自动重试收费请求。

## 和风预警配置

和风属于可选真实预警供应商；没有配置时接口明确返回 `not_configured`，高德预报仍可使用。高德降雨/高温条件建议不冒充官方预警。

1. 在和风开发者平台创建项目和 API Key，确认账号具备 Weather Alert API 访问权限及套餐额度。
2. 从平台复制自己的 API Host（形如 `abcxyz.qweatherapi.com`），仅在本机 `.env` 或服务器密钥配置填写：

```dotenv
QWEATHER_API_HOST=账号分配的主机.qweatherapi.com
QWEATHER_API_KEY=自行填写
QWEATHER_DAILY_REQUEST_LIMIT=50
```

3. 重启后端，查看本人近期行程的天气按钮。不要把 Key 放到聊天、客户端或 Git。不能用测试替身结果证明账号已经获授权。

采用请求头 `X-QW-Api-Key`，不把密钥拼进URL；主机固定限制为账号的 `*.qweatherapi.com`。接口路径使用当前官方 `GET /weatheralert/v1/current/{latitude}/{longitude}`。该版本支持 API Key；官方也提供 JWT，若以后迁移认证应独立验收，当前没有实现 JWT 自动签发。

核对来源（2026-10-18）：[高德天气](https://lbs.amap.com/api/webservice/guide/api/weatherinfo)、[和风预警](https://dev.qweather.com/en/docs/api/warning/weather-alert/)、[和风认证](https://dev.qweather.com/en/docs/configuration/authentication/)。

测试：4项解析/供应商边界 + 1项真实HTTP/隔离数据库/20并发通过；供应商使用替身，不收费。网页集成已通过（含不可信预警文字纯文本呈现）；真实高德天气与和风预警凭据/覆盖验收另列。
