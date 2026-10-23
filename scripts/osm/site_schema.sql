-- 定义OSM site 关系、成员和构建版本的数据表、索引和关联结构。

CREATE TABLE IF NOT EXISTS osm.site_builds (
 build_id text PRIMARY KEY, algorithm text NOT NULL, sources jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 status text NOT NULL, summary jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS osm.site_objects (
 build_id text NOT NULL REFERENCES osm.site_builds(build_id), id text NOT NULL,
 name text, category text, subcategory text, is_site boolean NOT NULL,
 catalog_present boolean NOT NULL, tags jsonb NOT NULL,
 lon double precision, lat double precision, source_region text,
 source_version bigint, source_timestamp timestamptz,
 availability text NOT NULL, PRIMARY KEY(build_id,id)
);
CREATE TABLE IF NOT EXISTS osm.site_members (
 build_id text NOT NULL REFERENCES osm.site_builds(build_id),
 parent_id text NOT NULL, member_index integer NOT NULL,
 child_id text NOT NULL, role text NOT NULL, membership_kind text NOT NULL,
 PRIMARY KEY(build_id,parent_id,member_index),
 FOREIGN KEY(build_id,parent_id) REFERENCES osm.site_objects(build_id,id),
 FOREIGN KEY(build_id,child_id) REFERENCES osm.site_objects(build_id,id)
);
CREATE TABLE IF NOT EXISTS osm.site_edges (
 build_id text NOT NULL REFERENCES osm.site_builds(build_id),
 parent_id text NOT NULL, child_id text NOT NULL, roles text[] NOT NULL,
 status text NOT NULL, PRIMARY KEY(build_id,parent_id,child_id),
 FOREIGN KEY(build_id,parent_id) REFERENCES osm.site_objects(build_id,id),
 FOREIGN KEY(build_id,child_id) REFERENCES osm.site_objects(build_id,id)
);
CREATE INDEX IF NOT EXISTS site_edges_child ON osm.site_edges(build_id,child_id);
CREATE TABLE IF NOT EXISTS osm.site_object_summary (
 build_id text NOT NULL REFERENCES osm.site_builds(build_id), id text NOT NULL,
 parent_ids text[] NOT NULL, child_count integer NOT NULL,
 children_by_category jsonb NOT NULL, membership_status text NOT NULL,
 PRIMARY KEY(build_id,id),
 FOREIGN KEY(build_id,id) REFERENCES osm.site_objects(build_id,id)
);
CREATE TABLE IF NOT EXISTS osm.site_active (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 build_id text NOT NULL REFERENCES osm.site_builds(build_id)
);
CREATE OR REPLACE VIEW osm.current_site_objects AS
 SELECT o.* FROM osm.site_objects o JOIN osm.site_active a USING(build_id);
CREATE OR REPLACE VIEW osm.current_site_members AS
 SELECT m.* FROM osm.site_members m JOIN osm.site_active a USING(build_id);
CREATE OR REPLACE VIEW osm.current_site_edges AS
 SELECT e.* FROM osm.site_edges e JOIN osm.site_active a USING(build_id)
 WHERE e.status='source_reported';
CREATE OR REPLACE VIEW osm.current_site_summary AS
 SELECT s.* FROM osm.site_object_summary s JOIN osm.site_active a USING(build_id);
CREATE OR REPLACE VIEW osm.current_poi_hierarchy AS
 SELECT p.*,COALESCE(s.parent_ids,ARRAY[]::text[]) AS site_parent_ids,
 CASE WHEN cardinality(s.parent_ids)=1 THEN s.parent_ids[1] END AS site_parent_id,
 COALESCE(s.child_count,0) AS site_child_count,
 COALESCE(s.children_by_category,'{}'::jsonb) AS site_children_by_category,
 COALESCE(s.membership_status,'no_site_membership_recorded') AS site_membership_status
 FROM osm.current_poi p LEFT JOIN osm.current_site_summary s ON s.id=p.id;
