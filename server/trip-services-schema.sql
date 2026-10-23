-- 定义行程周边服务选择的数据表、索引和关联结构。

CREATE TABLE IF NOT EXISTS trip_service_recommendations (
 id uuid PRIMARY KEY, trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
 slot_id text NOT NULL, scope_key text NOT NULL, radius integer NOT NULL,
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '6 hours',
 UNIQUE(trip_id,slot_id,scope_key,radius)
);
CREATE INDEX IF NOT EXISTS trip_service_recommendations_expiry ON trip_service_recommendations(expires_at);
