CREATE EXTENSION IF NOT EXISTS postgis;
ALTER TABLE places ADD COLUMN IF NOT EXISTS location geography(Point,4326)
 GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng,lat),4326)::geography) STORED;
CREATE INDEX IF NOT EXISTS places_location_gist ON places USING gist(location);
-- Use the same canonical WGS84 coordinates in the database. Vendor coordinates
-- are converted only in the adapter and never replace the canonical columns.
