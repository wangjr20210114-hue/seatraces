-- New composers use their own source references. Legacy posts.trip_id/citywalk_id
-- and their unique constraints remain intact for old publishing clients.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS post_drafts (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title varchar(100) NOT NULL DEFAULT '', body varchar(4000) NOT NULL DEFAULT '', tags text[] NOT NULL DEFAULT '{}',
 source_kind text CHECK(source_kind IN ('journey','citywalk')), source_id uuid, source_version integer,
 snapshot jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
 edit_post_id uuid REFERENCES posts(id) ON DELETE SET NULL, edit_post_version integer,
 published_post_id uuid REFERENCES posts(id) ON DELETE SET NULL,
 media_ids uuid[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((source_kind IS NULL)=(source_id IS NULL)), CHECK(cardinality(media_ids)<=9), CHECK(cardinality(tags)<=8)
);
CREATE INDEX IF NOT EXISTS post_drafts_owner ON post_drafts(user_id,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS post_sources (
 post_id uuid PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('journey','citywalk')), source_id uuid NOT NULL, source_version integer NOT NULL,
 -- References are deliberately not foreign keys: deleting a private trip must
 -- not delete the user's separately published, privacy-filtered snapshot.
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS social_media (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 draft_id uuid REFERENCES post_drafts(id) ON DELETE SET NULL,
 width integer NOT NULL, height integer NOT NULL, bytes integer NOT NULL CHECK(bytes>0 AND bytes<=1500000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_media_owner ON social_media(user_id);
CREATE TABLE IF NOT EXISTS post_media (
 post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 media_id uuid NOT NULL REFERENCES social_media(id), position integer NOT NULL CHECK(position BETWEEN 0 AND 8),
 PRIMARY KEY(post_id,media_id), UNIQUE(post_id,position)
);
CREATE TABLE IF NOT EXISTS social_ai_jobs (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 draft_id uuid NOT NULL REFERENCES post_drafts(id) ON DELETE CASCADE, draft_version integer NOT NULL,
 state text NOT NULL CHECK(state IN ('running','ready','failed')), result jsonb, error varchar(200),
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS social_ai_pending ON social_ai_jobs(draft_id,draft_version) WHERE state='running';
CREATE INDEX IF NOT EXISTS social_ai_owner_time ON social_ai_jobs(user_id,created_at DESC);
