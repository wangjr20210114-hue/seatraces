CREATE TABLE IF NOT EXISTS maintenance_tasks (
 id uuid PRIMARY KEY,
 kind text NOT NULL CHECK(kind IN ('health_check','event_archive','daily_rollup')),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed','interrupted','cancelled')),
 requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
 retry_of uuid REFERENCES maintenance_tasks(id),
 parameters jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(parameters)='object'),
 progress jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(progress)='object'),
 result jsonb,
 error_code varchar(60),
 cancel_requested boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1,
 worker_id uuid,
 lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS maintenance_tasks_state_time ON maintenance_tasks(state,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_tasks_one_retry ON maintenance_tasks(retry_of) WHERE retry_of IS NOT NULL;
CREATE TABLE IF NOT EXISTS operational_samples (
 id bigserial PRIMARY KEY,
 sampled_at timestamptz NOT NULL DEFAULT now(),
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object')
);
CREATE INDEX IF NOT EXISTS operational_samples_time ON operational_samples(sampled_at DESC);
CREATE TABLE IF NOT EXISTS operational_alerts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 rule text NOT NULL CHECK(rule IN ('api_errors','heap_pressure','log_queue','log_loss','task_failures')),
 level text NOT NULL CHECK(level IN ('warning','critical')),
 state text NOT NULL CHECK(state IN ('open','acknowledged','resolved')),
 observed jsonb NOT NULL,
 opened_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 acknowledged_at timestamptz,
 acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
 resolved_at timestamptz,
 version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS operational_alerts_one_active ON operational_alerts(rule) WHERE state<>'resolved';
CREATE INDEX IF NOT EXISTS operational_alerts_state_time ON operational_alerts(state,last_seen_at DESC);
