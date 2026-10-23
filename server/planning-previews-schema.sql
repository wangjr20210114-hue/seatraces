-- 定义行程调整预览方案的数据表、索引和关联结构。

CREATE TABLE IF NOT EXISTS trip_plan_previews (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
 base_version int NOT NULL,day_index int NOT NULL CHECK(day_index BETWEEN 0 AND 29),
 payload jsonb NOT NULL,version int NOT NULL DEFAULT 1,applied_version int,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
CREATE INDEX IF NOT EXISTS trip_plan_preview_owner ON trip_plan_previews(user_id,expires_at);
