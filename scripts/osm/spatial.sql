CREATE EXTENSION IF NOT EXISTS postgis;
ALTER TABLE osm.poi ADD COLUMN IF NOT EXISTS location geography(Point,4326)
 GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon,lat),4326)::geography) STORED;
CREATE INDEX IF NOT EXISTS osm_poi_location ON osm.poi USING gist(location);
