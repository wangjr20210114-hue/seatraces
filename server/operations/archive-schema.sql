ALTER TABLE maintenance_tasks DROP CONSTRAINT IF EXISTS maintenance_tasks_kind_check;
ALTER TABLE maintenance_tasks ADD CONSTRAINT maintenance_tasks_kind_check CHECK(kind IN ('health_check','event_archive','daily_rollup','archive_restore','log_export','place_refresh'));
CREATE TABLE IF NOT EXISTS event_archive_previews (
 id uuid PRIMARY KEY,
 requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
 stream text NOT NULL CHECK(stream IN ('operation','product')),
 from_day date NOT NULL,
 to_day date NOT NULL,
 selected_ids jsonb NOT NULL CHECK(jsonb_typeof(selected_ids)='array'),
 selected_count integer NOT NULL CHECK(selected_count BETWEEN 0 AND 20000),
 processed_count integer NOT NULL DEFAULT 0 CHECK(processed_count>=0 AND processed_count<=selected_count),
 source_bytes bigint NOT NULL,
 task_id uuid REFERENCES maintenance_tasks(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour'
);
CREATE TABLE IF NOT EXISTS event_archives (
 id uuid PRIMARY KEY,
 preview_id uuid NOT NULL REFERENCES event_archive_previews(id),
 stream text NOT NULL CHECK(stream IN ('operation','product')),
 row_count integer NOT NULL CHECK(row_count>0 AND row_count<=500),
 first_at timestamptz NOT NULL,
 last_at timestamptz NOT NULL,
 raw_bytes integer NOT NULL CHECK(raw_bytes BETWEEN 1 AND 2097152),
 sha256 char(64) NOT NULL,
 payload bytea NOT NULL CHECK(octet_length(payload)<=2100000),
 user_index jsonb NOT NULL DEFAULT '{}',
 event_ids text[] NOT NULL,
 request_ids uuid[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 restored_at timestamptz,
 restore_task_id uuid REFERENCES maintenance_tasks(id),
 restore_result jsonb,
 version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS event_archives_time ON event_archives(first_at,last_at);
CREATE INDEX IF NOT EXISTS event_archives_preview ON event_archives(preview_id);
CREATE INDEX IF NOT EXISTS event_archives_users ON event_archives USING gin(user_index);
CREATE INDEX IF NOT EXISTS event_archives_events ON event_archives USING gin(event_ids);
CREATE INDEX IF NOT EXISTS event_archives_requests ON event_archives USING gin(request_ids);
CREATE TABLE IF NOT EXISTS analytics_daily_rollups (
 day date PRIMARY KEY,
 metrics jsonb NOT NULL,
 coverage jsonb NOT NULL,
 frozen boolean NOT NULL DEFAULT false,
 computed_at timestamptz NOT NULL DEFAULT now()
);
