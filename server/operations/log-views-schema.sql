-- 定义日志查询视图的数据表、索引和关联结构。

CREATE TABLE IF NOT EXISTS admin_log_views (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name varchar(50) NOT NULL,
 filters jsonb NOT NULL CHECK(jsonb_typeof(filters)='object'),
 columns jsonb NOT NULL CHECK(jsonb_typeof(columns)='array'),
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,name)
);
CREATE INDEX IF NOT EXISTS admin_log_views_owner_time ON admin_log_views(owner_id,updated_at DESC);
