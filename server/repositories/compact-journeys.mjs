/* 精简已保存的问卷地点资料。 */

import {
  catalogSummarySql,
  scenicSummaryVersion,
} from "../domain/scenic-summary.mjs";
export const legacyPredicate = `EXISTS(SELECT 1 FROM jsonb_each(catalog)c WHERE jsonb_typeof(c.value->'clusters')='array' AND c.value->>'snapshotFormat' IS DISTINCT FROM '${scenicSummaryVersion}')`;
const identitySql = `WITH RECURSIVE p(value,depth) AS (
  SELECT value,0 FROM journey_sessions s CROSS JOIN LATERAL jsonb_path_query(s.catalog,'$.*.clusters[*].members[*]') roots(value) WHERE s.id=$1
  UNION ALL SELECT child.value,p.depth+1 FROM p CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.value->'children','[]'))child WHERE p.depth<32
) SELECT count(*)::int count,md5(coalesce(jsonb_agg(jsonb_build_array(value->'id',value->'parentId',value->'displayParentId',value->'hierarchyLevel',value->'wanted',value->'ownWanted') ORDER BY value->>'id',depth)::text,'')) identity FROM p`;
export async function compactJourneyCatalogs({
  query,
  transaction,
  onProgress = () => {},
}) {
  const result = { sessions: 0, beforeBytes: 0, afterBytes: 0 };
  for (;;) {
    const change = await transaction(async (c) => {
      const row = (
        await c.query(
          `SELECT id,octet_length(catalog::text) bytes FROM journey_sessions WHERE ${legacyPredicate} ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
        )
      ).rows[0];
      if (!row) return null;
      const before = (await c.query(identitySql, [row.id])).rows[0];
      const after = (
        await c.query(
          `UPDATE journey_sessions SET catalog=${catalogSummarySql("catalog")} WHERE id=$1 RETURNING octet_length(catalog::text) bytes`,
          [row.id],
        )
      ).rows[0];
      const identity = (await c.query(identitySql, [row.id])).rows[0];
      if (
        before.count !== identity.count ||
        before.identity !== identity.identity
      )
        throw Error("Compaction changed place identities, hierarchy or wishes");
      return { before: row.bytes, after: after.bytes };
    });
    if (!change) break;
    result.sessions++;
    result.beforeBytes += change.before;
    result.afterBytes += change.after;
    await onProgress({ ...result });
  }
  const remaining = (
    await query(
      `SELECT count(*)::int count FROM journey_sessions WHERE ${legacyPredicate}`,
    )
  ).rows[0].count;
  return { ...result, remaining };
}
