-- Place metadata is independent of user questionnaires and immutable raw OSM.
-- IDs may belong to the read-only OSM catalog, so there is no local places FK.
CREATE TABLE IF NOT EXISTS place_descriptions (
 place_id text PRIMARY KEY CHECK(length(place_id) BETWEEN 1 AND 80),
 short_text text NOT NULL CHECK(length(short_text) BETWEEN 1 AND 120),
 full_text text NOT NULL CHECK(length(full_text) BETWEEN 1 AND 1000),
 evidence jsonb NOT NULL CHECK(pg_column_size(evidence)<12000),
 source_hash text NOT NULL,
 method text NOT NULL CHECK(method IN ('existing_facts','llm_extract')),
 generated_at timestamptz NOT NULL DEFAULT now(),
 refresh_after timestamptz NOT NULL
);
