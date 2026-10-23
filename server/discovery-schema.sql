-- 定义路线分享和发现页内容的数据表、索引和关联结构。

ALTER TABLE posts ADD COLUMN IF NOT EXISTS auto_shared boolean NOT NULL DEFAULT false;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS citywalk_id uuid REFERENCES citywalks(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS posts_citywalk ON posts(citywalk_id);
CREATE INDEX IF NOT EXISTS posts_author_published ON posts(user_id,created_at DESC,id DESC) WHERE NOT auto_shared;
DROP TRIGGER IF EXISTS trips_discovery_sync ON trips;
DROP TRIGGER IF EXISTS citywalks_discovery_sync ON citywalks;
DROP FUNCTION IF EXISTS sync_route_discovery();
DROP FUNCTION IF EXISTS discovery_stops(jsonb);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS moderation_version integer NOT NULL DEFAULT 1;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS moderation_version integer NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS posts_visible_created ON posts(created_at DESC,id) WHERE hidden_at IS NULL AND NOT auto_shared;
