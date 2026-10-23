/* 通过数据库游标逐条读取已保存的城市选择快照。 */

import { scenicSummarySql } from "../domain/scenic-summary.mjs";

const snapshotRowsSql = `DECLARE journey_snapshot NO SCROLL CURSOR FOR
  WITH city AS MATERIALIZED (
    SELECT catalog->$3 value FROM journey_sessions
    WHERE id=$1 AND user_id=$2 AND catalog ? $3
  ), groups AS MATERIALIZED (
    SELECT g.value,g.ordinality n FROM city,
      jsonb_array_elements(city.value->'clusters') WITH ORDINALITY g
  ), records AS (
    SELECT 0::bigint g,0::bigint p,'header' kind,value-'clusters'-'boundary' data FROM city
    UNION ALL
    SELECT n,0,'group',value-'members' FROM groups
    UNION ALL
    SELECT g.n,p.ordinality,'place',${scenicSummarySql("p.value")}
    FROM groups g, jsonb_array_elements(g.value->'members') WITH ORDINALITY p
  )
  SELECT kind,CASE WHEN octet_length(data::text)<=8388608 THEN data ELSE NULL END data
  FROM records ORDER BY g,p`;

export async function withSavedCityRows(
  { transaction, sessionId, userId, cityId }, consume,
) {
  return transaction(async (db) => {
    await db.query(snapshotRowsSql, [sessionId, userId, cityId]);
    const next = async () => {
      const row = (await db.query("FETCH FORWARD 1 FROM journey_snapshot")).rows[0];
      if (row && !row.data)
        throw Object.assign(Error("单个地点资料异常，请稍后重试"), { status: 413 });
      return row;
    };
    const header = await next();
    if (!header) return false;
    await consume(header.data, (async function* () {
      for (let row; (row = await next());) yield row;
    })());
    return true;
  });
}
