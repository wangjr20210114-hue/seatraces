/* 在独立进程中检查旅行快照读取与内存占用。 */

import pg from "pg";
import { readFile } from "node:fs/promises";
import { withSavedCityRows } from "../../server/repositories/journey-snapshot.mjs";

const [schema, sessionId, userId] = process.argv.slice(2);
if (!/^iteration_[a-f0-9]{16}$/.test(schema)) throw Error("isolated fixture required");
const cfg = JSON.parse(await readFile(process.env.ITERATION_DB_CONFIG || new URL("../../.runtime/local.json", import.meta.url), "utf8"));
const db = new pg.Client({ host: "127.0.0.1", port: cfg.port, user: "seatraces", password: cfg.password,
  database: "seatraces", options: "-c search_path=" + schema + ",public" });
let peakHeapMB = 0, places = 0;
try {
  await db.connect();
  await withSavedCityRows({ sessionId, userId, cityId: "beijing", transaction: async fn => {
    await db.query("BEGIN");
    try { const result = await fn(db); await db.query("COMMIT"); return result; }
    catch (e) { await db.query("ROLLBACK"); throw e; }
  } }, async (_header, rows) => {
    for await (const row of rows) {
      if (row.kind === "place") places++;
      peakHeapMB = Math.max(peakHeapMB, Math.ceil(process.memoryUsage().heapUsed / 1048576));
    }
  });
  console.log(JSON.stringify({ places, peakHeapMB }));
} finally { await db.end(); }
