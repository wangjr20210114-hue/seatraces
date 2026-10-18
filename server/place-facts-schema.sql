CREATE TABLE IF NOT EXISTS official_place_sources (
 id text PRIMARY KEY,place_id text NOT NULL,place_name text NOT NULL,publisher text NOT NULL,url text NOT NULL,
 fields jsonb NOT NULL,enabled boolean NOT NULL DEFAULT true,checked_at timestamptz,refresh_after timestamptz,
 source_hash text,source_text text,last_status text NOT NULL DEFAULT 'unfetched',version int NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS official_place_facts (
 place_id text NOT NULL,field text NOT NULL,source_id text NOT NULL REFERENCES official_place_sources(id),
 fact jsonb NOT NULL,version int NOT NULL DEFAULT 1,PRIMARY KEY(place_id,field)
);
CREATE TABLE IF NOT EXISTS official_fact_reviews (
 id uuid PRIMARY KEY,source_id text NOT NULL REFERENCES official_place_sources(id),place_id text NOT NULL,
 field text NOT NULL,fact jsonb NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','rejected','superseded')),
 created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz,reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
 version int NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS place_fact_demand (
 place_id text PRIMARY KEY,uses bigint NOT NULL DEFAULT 1,last_requested_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE maintenance_tasks DROP CONSTRAINT IF EXISTS maintenance_tasks_kind_check;
ALTER TABLE maintenance_tasks ADD CONSTRAINT maintenance_tasks_kind_check CHECK(kind IN ('health_check','event_archive','daily_rollup','archive_restore','log_export','place_refresh'));
