-- Sharing is explicit. Remove the previous automatic publication triggers on upgrade.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS auto_shared boolean NOT NULL DEFAULT false;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS citywalk_id uuid REFERENCES citywalks(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS posts_citywalk ON posts(citywalk_id);
CREATE INDEX IF NOT EXISTS posts_author_published ON posts(user_id,created_at DESC,id DESC) WHERE NOT auto_shared;
DROP TRIGGER IF EXISTS trips_discovery_sync ON trips;
DROP TRIGGER IF EXISTS citywalks_discovery_sync ON citywalks;
DROP FUNCTION IF EXISTS sync_route_discovery();
DROP FUNCTION IF EXISTS discovery_stops(jsonb);
-- Older automatic posts are retained, but hidden from feeds until explicitly published.
