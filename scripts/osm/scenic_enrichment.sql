-- 定义景区事实与层级补充资料的数据表、索引和关联结构。

ALTER TABLE osm.place_facts ALTER COLUMN source_timestamp DROP NOT NULL;
ALTER TABLE osm.place_facts DROP CONSTRAINT IF EXISTS place_facts_field_check;
ALTER TABLE osm.place_facts ADD CONSTRAINT place_facts_field_check CHECK(field IN
 ('openingHours','lastEntry','ticketPrice','reservation','website','phone','wheelchair','checkIn','checkOut','address','stayMinutes','access','description'));
CREATE TABLE IF NOT EXISTS osm.place_relationships (
 id uuid PRIMARY KEY, child_id text NOT NULL, parent_id text NOT NULL,
 relation_type text NOT NULL CHECK(relation_type IN ('part_of','located_in','nearby')),
 source_name text NOT NULL,source_url text NOT NULL,source_timestamp timestamptz,
 verified_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
 evidence jsonb NOT NULL, CHECK(child_id<>parent_id)
);
CREATE INDEX IF NOT EXISTS relationships_child ON osm.place_relationships(child_id,verified_at DESC);
CREATE INDEX IF NOT EXISTS relationships_parent ON osm.place_relationships(parent_id);
CREATE TABLE IF NOT EXISTS osm.enrichment_batches (
 batch_id text PRIMARY KEY,payload_sha256 text NOT NULL,payload jsonb NOT NULL,
 applied_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON osm.place_relationships TO seatraces_osm_reader;
