CREATE SCHEMA IF NOT EXISTS osm;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS osm.imports (
 id uuid PRIMARY KEY, region text NOT NULL, pbf_sha256 text NOT NULL,
 pbf_timestamp timestamptz, loaded_at timestamptz NOT NULL DEFAULT now(),
 rows_count bigint NOT NULL, manifest jsonb NOT NULL,
 UNIQUE(region,pbf_sha256)
);
CREATE TABLE IF NOT EXISTS osm.poi (
 import_id uuid NOT NULL REFERENCES osm.imports(id),
 id text NOT NULL, osm_type text NOT NULL CHECK(osm_type IN ('node','way','relation')),
 osm_id bigint NOT NULL, name text NOT NULL, aliases text[] NOT NULL,
 category text NOT NULL, subcategory text NOT NULL,
 lon double precision NOT NULL CHECK(lon BETWEEN -180 AND 180),
 lat double precision NOT NULL CHECK(lat BETWEEN -90 AND 90),
 geometry_kind text NOT NULL, coordinate_role text NOT NULL,
 country_code text, province text, city text, opening_hours text, fee text, access text,
 selectable boolean NOT NULL, tags jsonb NOT NULL, search_text text NOT NULL,
 PRIMARY KEY(import_id,id)
);
CREATE INDEX IF NOT EXISTS osm_poi_search ON osm.poi USING gin(search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS osm_poi_category ON osm.poi(category,subcategory);
CREATE INDEX IF NOT EXISTS osm_poi_coordinates ON osm.poi(lat,lon);
CREATE INDEX IF NOT EXISTS osm_poi_city ON osm.poi(city);
-- pg_trgm cannot prune an unanchored two-character query such as 外滩.
-- Exact two-character candidates use GIN pairs, followed by the original ILIKE.
CREATE OR REPLACE FUNCTION osm.search_pairs(value text) RETURNS text[]
 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT coalesce(array_agg(DISTINCT substr(lower(value),n,2)),ARRAY[]::text[])
 FROM generate_series(1,char_length(value)-1) AS n;
$$;
ALTER TABLE osm.poi ADD COLUMN IF NOT EXISTS name_pairs text[]
 GENERATED ALWAYS AS (osm.search_pairs(search_text)) STORED;
CREATE INDEX IF NOT EXISTS osm_poi_name_pairs ON osm.poi USING gin(name_pairs);
CREATE TABLE IF NOT EXISTS osm.active_imports (
 region text PRIMARY KEY, import_id uuid NOT NULL REFERENCES osm.imports(id)
);
CREATE OR REPLACE VIEW osm.current_poi AS
 SELECT DISTINCT ON (p.id)
 p.import_id,p.id,p.osm_type,p.osm_id,p.name,p.aliases,p.category,p.subcategory,
 p.lon,p.lat,p.geometry_kind,p.coordinate_role,p.country_code,p.province,p.city,
 p.opening_hours,p.fee,p.access,p.selectable,p.tags,p.search_text,
 i.region AS extract_region, i.pbf_timestamp
 FROM osm.poi p JOIN osm.active_imports a ON a.import_id=p.import_id
 JOIN osm.imports i ON i.id=p.import_id
 ORDER BY p.id,i.pbf_timestamp DESC NULLS LAST,i.loaded_at DESC;
