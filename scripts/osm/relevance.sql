-- 按地点名称和别名的匹配程度计算检索排序。

CREATE OR REPLACE FUNCTION osm.name_match_cost(place_name text, place_aliases text[], term text)
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN nullif(btrim(term),'') IS NULL THEN 0 ELSE
  coalesce((SELECT min(greatest(char_length(label)-char_length(btrim(term)),0))
   FROM unnest(ARRAY[place_name] || coalesce(place_aliases,ARRAY[]::text[])) AS names(label)
   WHERE strpos(lower(label COLLATE "und-x-icu"),lower(btrim(term) COLLATE "und-x-icu"))>0),100000)
 END;
$$;
