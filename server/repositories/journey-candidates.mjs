import { scenicSummarySql } from "../domain/scenic-summary.mjs";
import { applyWishes } from "../domain/scenic-entities.mjs";

const failure = (message, status = 400) =>
  Object.assign(Error(message), { status });
export async function catalogMember({
  query,
  sessionId,
  userId,
  placeId,
  includeChildren = false,
}) {
  const r = await query(
    `WITH RECURSIVE members(value,depth) AS (
    SELECT p.value,0 FROM journey_sessions s CROSS JOIN LATERAL jsonb_path_query(s.catalog,'$.*.clusters[*].members[*]') p(value)
      WHERE s.id=$1 AND s.user_id=$2
    UNION ALL SELECT child.value,m.depth+1 FROM members m CROSS JOIN LATERAL jsonb_array_elements(coalesce(m.value->'children','[]')) child
      WHERE $4 AND m.depth<8
  ) SELECT value->>'id' id,value->'possibleDuplicateIds' "possibleDuplicateIds" FROM members WHERE value->>'id'=$3 ORDER BY depth LIMIT 1`,
    [sessionId, userId, placeId, includeChildren],
  );
  return r.rows[0] || null;
}
export async function catalogCoordinates({ query, sessionId, userId, cityId }) {
  const r = await query(
    `SELECT g.value->>'id' id,coalesce((SELECT jsonb_agg(jsonb_build_object('lat',p.value->'lat','lng',p.value->'lng'))
    FROM jsonb_array_elements(g.value->'members')p),'[]') members
    FROM journey_sessions s CROSS JOIN LATERAL jsonb_array_elements(s.catalog->$3->'clusters')g
    WHERE s.id=$1 AND s.user_id=$2`,
    [sessionId, userId, cityId],
  );
  return r.rows;
}
// The database owns the full catalog. Transfer only the already-defined planning
// shortlist, rather than parsing tens of MB twice in the HTTP process.
export async function planningPools({
  query,
  sessionId,
  userId,
  cities,
  selections,
  wishes = {},
}) {
  const pools = {},
    wantedIds = Object.keys(wishes).filter((id) => wishes[id] === true);
  let remainingBytes = 8 * 1024 * 1024;
  for (const city of cities) {
    const ids = selections[city.id];
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 30 ||
      new Set(ids).size !== ids.length
    )
      throw failure("每座城市请选择 1～30 个片区");
    const info = (
      await query(
        `SELECT catalog ? $3 AS available,
      jsonb_path_query_array(catalog->$3,'$.clusters[*].id') AS groups
      FROM journey_sessions WHERE id=$1 AND user_id=$2`,
        [sessionId, userId, city.id],
      )
    ).rows[0];
    if (!info) throw failure("问卷不存在", 404);
    if (!info.available) throw failure("请先选择每座城市的片区");
    if (ids.some((id) => !info.groups.includes(id)))
      throw failure("景点片区已经变化，请重新选择");
    const rows = (
      await query(
        `WITH members AS MATERIALIZED (
      SELECT m.value, g.value->>'id' group_id,array_position($4::text[],g.value->>'id') group_order,m.ord
      FROM journey_sessions s CROSS JOIN LATERAL jsonb_array_elements(s.catalog->$3->'clusters') g
      CROSS JOIN LATERAL jsonb_array_elements(g.value->'members') WITH ORDINALITY m(value,ord)
      WHERE s.id=$1 AND s.user_id=$2 AND g.value->>'id'=ANY($4::text[])
    ), candidates AS MATERIALIZED (
      SELECT *,CASE WHEN cardinality($5::text[])=0 THEN false ELSE EXISTS(
        WITH RECURSIVE tree(value) AS (SELECT members.value UNION ALL
          SELECT child.value FROM tree t CROSS JOIN LATERAL jsonb_array_elements(coalesce(t.value->'children','[]'::jsonb)) child)
        SELECT 1 FROM tree t WHERE t.value->>'id'=ANY($5::text[]) OR EXISTS(
          SELECT 1 FROM jsonb_array_elements_text(coalesce(t.value->'possibleDuplicateIds','[]'::jsonb)) d(id) WHERE d.id=ANY($5::text[]))
      ) END wanted FROM members
    ), ranked AS (
      SELECT *,row_number() OVER(PARTITION BY value->>'id'
        ORDER BY wanted DESC,CASE WHEN wanted THEN group_order END,ord,group_order) duplicate_order FROM candidates
    ), selected AS (
      SELECT * FROM ranked WHERE duplicate_order=1 AND wanted UNION ALL
      (SELECT * FROM ranked WHERE duplicate_order=1 AND NOT wanted ORDER BY ord,group_order LIMIT 60)
    ), compact AS MATERIALIZED (SELECT *,${scenicSummarySql("value")} summary FROM selected),
    sized AS (SELECT *,sum(octet_length(summary::text)) OVER() total_bytes FROM compact)
    SELECT CASE WHEN total_bytes<=$6 THEN summary ELSE NULL END point,group_id,total_bytes
    FROM sized ORDER BY wanted DESC,CASE WHEN wanted THEN group_order END,ord,group_order`,
        [sessionId, userId, city.id, ids, wantedIds, remainingBytes],
      )
    ).rows;
    // Never silently drop wishes or remove places from the underlying catalog.
    if (rows.some((r) => r.point === null))
      throw failure("所选景点资料过多，请减少本次选择的片区后重试", 413);
    remainingBytes -= Number(rows[0]?.total_bytes || 0);
    pools[city.id] = rows.map((r) => ({
      ...applyWishes(r.point, wishes),
      clusterId: r.group_id,
    }));
  }
  return pools;
}
