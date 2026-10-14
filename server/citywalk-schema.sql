-- User-owned routes and short-lived, server-verified selection catalogs.
CREATE TABLE IF NOT EXISTS citywalks (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title varchar(80) NOT NULL, city jsonb NOT NULL, stops jsonb NOT NULL,
 cluster_ids text[] NOT NULL DEFAULT '{}', distance_m integer NOT NULL CHECK(distance_m >= 0),
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(stops) = 'array' AND jsonb_array_length(stops) >= 2)
);
CREATE INDEX IF NOT EXISTS citywalks_owner ON citywalks(user_id, updated_at DESC, id);
CREATE TABLE IF NOT EXISTS citywalk_drafts (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 city jsonb NOT NULL, catalog jsonb NOT NULL, expires_at timestamptz NOT NULL DEFAULT now() + interval '1 day'
);
CREATE INDEX IF NOT EXISTS citywalk_drafts_expiry ON citywalk_drafts(expires_at);
