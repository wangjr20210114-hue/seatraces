-- 定义地点名称和空间范围检索函数。

CREATE OR REPLACE FUNCTION osm.search_places(
 q text, wanted_category text DEFAULT NULL,
 center_lon double precision DEFAULT NULL, center_lat double precision DEFAULT NULL,
 radius_m double precision DEFAULT 10000, result_limit integer DEFAULT 30
) RETURNS TABLE (
 id text,name text,aliases text[],category text,subcategory text,
 lon double precision,lat double precision,distance_m double precision,
 opening_hours text,fee text,city text,coordinate_role text,source_timestamp timestamptz
) LANGUAGE plpgsql STABLE SET plan_cache_mode=force_custom_plan AS $$
BEGIN
 IF char_length(coalesce(q,'')) > 120 OR result_limit IS NULL OR result_limit NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'Query too long or result limit outside 1..100';
 END IF;
 IF (center_lon IS NULL) <> (center_lat IS NULL) THEN
  RAISE EXCEPTION 'Both center coordinates are required';
 END IF;
 IF center_lon IS NOT NULL AND
    (center_lon NOT BETWEEN -180 AND 180 OR center_lat NOT BETWEEN -90 AND 90 OR radius_m IS NULL OR radius_m NOT BETWEEN 1 AND 100000) THEN
  RAISE EXCEPTION 'Invalid center or radius (1..100000 metres)';
 END IF;
 IF char_length(trim(coalesce(q,''))) < 2 AND center_lon IS NULL THEN
  RAISE EXCEPTION 'Enter at least two characters or provide a nearby-search center';
 END IF;
 RETURN QUERY
 WITH candidates AS (
  SELECT p.*, i.pbf_timestamp,i.loaded_at,
   CASE WHEN center_lon IS NOT NULL THEN ST_Distance(p.location,ST_SetSRID(ST_MakePoint(center_lon,center_lat),4326)::geography) END AS distance_value
  FROM osm.poi p JOIN osm.active_imports a ON a.import_id=p.import_id
  JOIN osm.imports i ON i.id=p.import_id
  WHERE p.selectable
   AND (char_length(trim(q)) <> 2 OR q IS NULL OR p.name_pairs @> ARRAY[lower(trim(q))])
   AND (nullif(trim(q),'') IS NULL OR p.search_text ILIKE '%' || replace(replace(replace(trim(q),E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_') || '%')
   AND (wanted_category IS NULL OR p.category=wanted_category)
   AND (center_lon IS NULL OR ST_DWithin(p.location,ST_SetSRID(ST_MakePoint(center_lon,center_lat),4326)::geography,radius_m))
 ), unique_objects AS (
  SELECT DISTINCT ON (c.id) c.* FROM candidates c
  ORDER BY c.id,c.pbf_timestamp DESC NULLS LAST,c.loaded_at DESC
 )
 SELECT u.id,u.name,u.aliases,u.category,u.subcategory,u.lon,u.lat,u.distance_value,
  u.opening_hours,u.fee,u.city,u.coordinate_role,u.pbf_timestamp
 FROM unique_objects u
 ORDER BY osm.name_match_cost(u.name,u.aliases,q),u.distance_value NULLS LAST,u.name,u.id
 LIMIT result_limit;
END;
$$;
