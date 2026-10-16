// Questionnaires retain presentation/planning data, not full provenance copies.
// Complete OSM records stay behind /api/catalog/place and /place-batch; inference
// evidence stays in scenic_hierarchy_results and is loaded by the detail route.
export const scenicSummaryVersion = "scenic-summary/1";
export const summaryFields = [
  "id",
  "name",
  "aliases",
  "category",
  "subcategory",
  "lat",
  "lng",
  "coord_system",
  "coordinate_role",
  "coordinateRole",
  "city",
  "province",
  "country",
  "region",
  "timezone",
  "district",
  "mainlandCityVerified",
  "access",
  "opening_hours",
  "traits",
  "facts",
  "source",
  "source_url",
  "source_timestamp",
  "license",
  "score",
  "signals",
  "wanted",
  "ownWanted",
  "visited",
  "visitHistory",
  "parentId",
  "hierarchyLevel",
  "displayParentId",
  "hierarchyOnly",
  "geometricHierarchy",
  "entityIdentity",
  "possibleDuplicateIds",
  "childPlaceIds",
  "sourceRecordCount",
  "entityType",
  "groupingEvidence",
  "groupingReviewNeeded",
  "parentLookup",
  "cacheStatus",
  "cachedAt",
  "duration_min",
  "clusterId",
];
const relationFields = [
  "status",
  "method",
  "provider",
  "checkedAt",
  "requiresReview",
];
const inferenceFields = [
  "status",
  "parentId",
  "method",
  "provider",
  "checkedAt",
  "sourceHash",
];
const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((k) => value?.[k] !== undefined).map((k) => [k, value[k]]),
  );
export function scenicSummary(place, depth = 0) {
  if (depth > 32)
    throw Object.assign(Error("景点层级异常，请重新加载"), { status: 422 });
  const result = pick(place, summaryFields);
  if (place.parentRelation)
    result.parentRelation = pick(place.parentRelation, relationFields);
  if (place.hierarchyInference)
    result.hierarchyInference = pick(place.hierarchyInference, inferenceFields);
  result.sourceRecords = (place.sourceRecords || [{ id: place.id }])
    .filter((p) => p.id)
    .map((p) => ({ id: p.id }));
  result.children = (place.children || []).map((p) =>
    scenicSummary(p, depth + 1),
  );
  return result;
}
const literals = (keys) => keys.map((k) => "'" + k + "'").join(",");
const projection = (expr, keys) =>
  `(SELECT coalesce(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM jsonb_each(${expr}) f WHERE f.key IN (${literals(keys)}))`;
// Generated from trusted constants; no user string is interpolated into SQL.
// Eight nested child arrays cover the supported hierarchy. Deeper legacy data
// is retained for validation rather than silently truncated.
export function scenicSummarySql(expr, depth = 0) {
  const item = "child" + depth;
  const children =
    depth >= 8
      ? `coalesce(${expr}->'children','[]'::jsonb)`
      : `(SELECT coalesce(jsonb_agg(${scenicSummarySql(item + ".value", depth + 1)}),'[]'::jsonb) FROM jsonb_array_elements(coalesce(${expr}->'children','[]'::jsonb)) ${item})`;
  return `(${projection(expr, summaryFields)} ||
    CASE WHEN jsonb_typeof(${expr}->'parentRelation')='object' THEN jsonb_build_object('parentRelation',${projection(expr + "->'parentRelation'", relationFields)}) ELSE '{}'::jsonb END ||
    CASE WHEN jsonb_typeof(${expr}->'hierarchyInference')='object' THEN jsonb_build_object('hierarchyInference',${projection(expr + "->'hierarchyInference'", inferenceFields)}) ELSE '{}'::jsonb END ||
    jsonb_build_object('sourceRecords',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.value->'id')),'[]'::jsonb) FROM jsonb_array_elements(coalesce(${expr}->'sourceRecords',jsonb_build_array(jsonb_build_object('id',${expr}->'id'))))r WHERE r.value->>'id' IS NOT NULL),'children',${children}))`;
}

export function catalogSummarySql(expr) {
  return `(SELECT coalesce(jsonb_object_agg(c.key,CASE WHEN jsonb_typeof(c.value->'clusters')='array' THEN
    (c.value-'clusters') || jsonb_build_object('snapshotFormat','${scenicSummaryVersion}','clusters',
      (SELECT coalesce(jsonb_agg((g.value-'members') || jsonb_build_object('members',
        (SELECT coalesce(jsonb_agg(${scenicSummarySql("p.value")}),'[]'::jsonb) FROM jsonb_array_elements(g.value->'members')p))),'[]'::jsonb)
        FROM jsonb_array_elements(c.value->'clusters')g)) ELSE c.value END),'{}'::jsonb) FROM jsonb_each(${expr})c)`;
}
