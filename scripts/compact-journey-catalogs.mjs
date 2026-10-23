/* 执行历史问卷地点资料的精简任务。 */

import pg from "pg";
import {
  compactJourneyCatalogs,
  legacyPredicate,
} from "../server/repositories/compact-journeys.mjs";
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  statement_timeout: 60000,
});
pool.on("error", () => {});
const query = (...args) => pool.query(...args);
const transaction = async (fn) => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
};
try {
  if (process.argv.includes("--apply")) {
    if (!process.argv.includes("--backup-confirmed"))
      throw Error("A verified PostgreSQL backup is required before compaction");
    console.log(
      JSON.stringify(
        await compactJourneyCatalogs({
          query,
          transaction,
          onProgress: (v) =>
            console.log(JSON.stringify({ phase: "compacting", ...v })),
        }),
      ),
    );
  } else
    console.log(
      JSON.stringify(
        (
          await query(
            `SELECT count(*)::int sessions,coalesce(sum(octet_length(catalog::text)),0) bytes FROM journey_sessions WHERE ${legacyPredicate}`,
          )
        ).rows[0],
      ),
    );
} catch (e) {
  console.error(e.code || e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
