ALTER TABLE maintenance_tasks DROP CONSTRAINT IF EXISTS maintenance_tasks_kind_check;
ALTER TABLE maintenance_tasks ADD CONSTRAINT maintenance_tasks_kind_check CHECK(kind IN ('health_check','event_archive','daily_rollup','archive_restore','log_export','place_refresh'));
CREATE TABLE IF NOT EXISTS admin_log_exports (
 id uuid PRIMARY KEY REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 filters jsonb NOT NULL,
 selected_ids bigint[] NOT NULL,
 total_rows integer NOT NULL CHECK(total_rows BETWEEN 0 AND 100000),
 estimated_bytes bigint NOT NULL CHECK(estimated_bytes BETWEEN 0 AND 134217728),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours'
);
CREATE INDEX IF NOT EXISTS admin_log_exports_owner_time ON admin_log_exports(owner_id,created_at DESC);
CREATE TABLE IF NOT EXISTS admin_log_export_chunks (
 export_id uuid NOT NULL REFERENCES admin_log_exports(id) ON DELETE CASCADE,
 sequence integer NOT NULL,
 row_count integer NOT NULL CHECK(row_count BETWEEN 0 AND 50),
 raw_bytes integer NOT NULL CHECK(raw_bytes BETWEEN 0 AND 2097152),
 payload bytea NOT NULL,
 PRIMARY KEY(export_id,sequence)
);
CREATE INDEX IF NOT EXISTS operation_events_request_time ON operation_events(request_id,created_at DESC) WHERE request_id IS NOT NULL;
