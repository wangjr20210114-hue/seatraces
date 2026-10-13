-- Versioned derived hierarchy; osm.poi, site membership and editorial facts stay intact.
CREATE TABLE IF NOT EXISTS osm.containment_builds (
 build_id text PRIMARY KEY, algorithm text NOT NULL, sources jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 status text NOT NULL, summary jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS osm.containment_places (
 build_id text NOT NULL REFERENCES osm.containment_builds(build_id), id text NOT NULL,
 name text NOT NULL, category text NOT NULL, subcategory text,
 lon double precision NOT NULL, lat double precision NOT NULL,
 source_region text NOT NULL, source_timestamp timestamptz, source_version bigint,
 geometry_state text NOT NULL, geom geometry(Geometry,4326), area_m2 double precision NOT NULL DEFAULT 0,
 container_eligible boolean NOT NULL, is_container boolean NOT NULL DEFAULT false,
 PRIMARY KEY(build_id,id)
);
CREATE INDEX IF NOT EXISTS containment_parent_geometry
 ON osm.containment_places USING gist(geom) WHERE is_container;
CREATE TABLE IF NOT EXISTS osm.containment_edges (
 build_id text NOT NULL REFERENCES osm.containment_builds(build_id), child_id text NOT NULL,
 parent_id text NOT NULL, natural_parent_id text NOT NULL, root_id text,
 depth integer CHECK(depth BETWEEN 2 AND 8), natural_depth integer, depth_limited boolean NOT NULL DEFAULT false,
 PRIMARY KEY(build_id,child_id), CHECK(child_id<>parent_id),
 FOREIGN KEY(build_id,child_id) REFERENCES osm.containment_places(build_id,id),
 FOREIGN KEY(build_id,parent_id) REFERENCES osm.containment_places(build_id,id)
);
CREATE INDEX IF NOT EXISTS containment_parent_children ON osm.containment_edges(build_id,parent_id,child_id);
CREATE TABLE IF NOT EXISTS osm.containment_summary (
 build_id text NOT NULL REFERENCES osm.containment_builds(build_id), id text NOT NULL,
 child_count integer NOT NULL, children_by_category jsonb NOT NULL,
 PRIMARY KEY(build_id,id)
);
CREATE TABLE IF NOT EXISTS osm.containment_active (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 build_id text NOT NULL REFERENCES osm.containment_builds(build_id)
);
