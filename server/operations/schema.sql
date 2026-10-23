-- 定义后台操作日志的数据表、索引和关联结构。

CREATE TABLE IF NOT EXISTS operation_events (
 id bigserial PRIMARY KEY,
 user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 kind text NOT NULL CHECK(kind IN ('request','navigation','admin','system')),
 action varchar(120) NOT NULL,
 resource_id varchar(100),
 request_id uuid,
 status integer,
 duration_ms integer,
 metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operation_events_user_time ON operation_events(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS operation_events_kind_time ON operation_events(kind,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS operation_events_time ON operation_events(created_at DESC,id DESC);
