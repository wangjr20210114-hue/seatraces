-- 定义天气查询缓存的数据表、索引和关联结构。

CREATE TABLE IF NOT EXISTS city_weather_cache (
 city_key text PRIMARY KEY,
 adcode text NOT NULL CHECK(adcode ~ '^[0-9]{6}$'),
 payload jsonb NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS city_weather_alerts (
 city_key text PRIMARY KEY,payload jsonb NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL
);
