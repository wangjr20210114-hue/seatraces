-- Source POIs/facts and previous containment builds are immutable.
CREATE TABLE IF NOT EXISTS osm.entity_builds (
 build_id text PRIMARY KEY, containment_build text NOT NULL REFERENCES osm.containment_builds(build_id),
 algorithm text NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz, summary jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS osm.entity_members (
 build_id text NOT NULL REFERENCES osm.entity_builds(build_id), source_id text NOT NULL,
 canonical_id text NOT NULL, evidence jsonb NOT NULL, PRIMARY KEY(build_id,source_id)
);
CREATE INDEX IF NOT EXISTS entity_members_main ON osm.entity_members(build_id,canonical_id);
CREATE TABLE IF NOT EXISTS osm.entity_aliases (
 build_id text NOT NULL REFERENCES osm.entity_builds(build_id), canonical_id text NOT NULL,
 alias text NOT NULL, normalized text NOT NULL, source_id text NOT NULL,
 PRIMARY KEY(build_id,canonical_id,normalized)
);
CREATE INDEX IF NOT EXISTS entity_alias_search ON osm.entity_aliases(build_id,normalized);
CREATE TABLE IF NOT EXISTS osm.entity_edges (
 build_id text NOT NULL REFERENCES osm.entity_builds(build_id), child_id text NOT NULL,
 parent_id text NOT NULL, root_id text, depth integer CHECK(depth BETWEEN 2 AND 8),
 PRIMARY KEY(build_id,child_id), CHECK(child_id<>parent_id)
);
CREATE INDEX IF NOT EXISTS entity_edges_parent ON osm.entity_edges(build_id,parent_id,child_id);
CREATE TABLE IF NOT EXISTS osm.entity_summary (
 build_id text NOT NULL REFERENCES osm.entity_builds(build_id), id text NOT NULL,
 child_count integer NOT NULL, children_by_category jsonb NOT NULL, PRIMARY KEY(build_id,id)
);
CREATE TABLE IF NOT EXISTS osm.entity_active (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), build_id text NOT NULL REFERENCES osm.entity_builds(build_id)
);
