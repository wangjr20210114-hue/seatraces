-- Rank real names and language aliases ahead of address-only candidates.
-- Zero is an exact case-insensitive name/alias match. Shorter containing names
-- follow. The address fallback remains searchable but is ranked last.
CREATE OR REPLACE FUNCTION osm.name_match_cost(place_name text, place_aliases text[], term text)
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN nullif(btrim(term),'') IS NULL THEN 0 ELSE
  coalesce((SELECT min(greatest(char_length(label)-char_length(btrim(term)),0))
   FROM unnest(ARRAY[place_name] || coalesce(place_aliases,ARRAY[]::text[])) AS names(label)
   WHERE strpos(lower(label COLLATE "und-x-icu"),lower(btrim(term) COLLATE "und-x-icu"))>0),100000)
 END;
$$;
