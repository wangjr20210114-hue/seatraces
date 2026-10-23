-- 定义CityWalk 候选目录和道路缓存的数据表、索引和关联结构。

CREATE TABLE IF NOT EXISTS citywalk_route_legs (
 key char(64) PRIMARY KEY, payload jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day'
);
CREATE INDEX IF NOT EXISTS citywalk_route_legs_expiry ON citywalk_route_legs(expires_at);
ALTER TABLE citywalks ADD COLUMN IF NOT EXISTS verified_route jsonb;
CREATE TABLE IF NOT EXISTS classic_citywalks (
 id varchar(80) PRIMARY KEY, title varchar(80) NOT NULL, city jsonb NOT NULL,
 stops jsonb NOT NULL, sources jsonb NOT NULL, theme text NOT NULL DEFAULT 'mint', motif text NOT NULL DEFAULT 'bridge',
 route jsonb NOT NULL, enabled boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(stops)='array' AND jsonb_array_length(stops) BETWEEN 2 AND 20)
);
