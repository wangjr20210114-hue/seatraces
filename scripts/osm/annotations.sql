-- 定义地点补充资料与审计记录的数据表、索引和关联结构。

CREATE TABLE IF NOT EXISTS osm.editorial_aliases (
 place_id text NOT NULL, alias text NOT NULL CHECK(length(alias) BETWEEN 1 AND 120),
 language text NOT NULL, source_name text NOT NULL, source_url text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(place_id,alias)
);
CREATE INDEX IF NOT EXISTS editorial_alias_lookup ON osm.editorial_aliases(lower(alias));
CREATE TABLE IF NOT EXISTS osm.place_facts (
 id uuid PRIMARY KEY,place_id text NOT NULL,field text NOT NULL,
 value jsonb NOT NULL,source_name text NOT NULL,source_url text NOT NULL,
 source_timestamp timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
 verified_at timestamptz,
 CHECK(field IN ('openingHours','lastEntry','ticketPrice','reservation','website','phone','wheelchair','checkIn','checkOut','address','stayMinutes','access'))
);
CREATE INDEX IF NOT EXISTS facts_place_lookup ON osm.place_facts(place_id,field,recorded_at DESC);
ALTER TABLE osm.place_facts ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb;
GRANT SELECT ON osm.editorial_aliases,osm.place_facts TO seatraces_osm_reader;
