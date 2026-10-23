/* 在独立进程中测量行程处理的内存占用。 */

import pg from "pg";
import v8 from "node:v8";
import { readFile } from "node:fs/promises";
import { planningPools } from "../../server/repositories/journey-candidates.mjs";
import { createJourneyDraft } from "../../server/services/journey-draft.mjs";
const [schema, sessionId, userId, mode] = process.argv.slice(2);
if (!/^iteration_[a-f0-9]{16}$/.test(schema))
  throw Error("isolated fixture required");
const cfg = JSON.parse(
  await readFile(
    process.env.ITERATION_DB_CONFIG ||
      new URL("../../.runtime/local.json", import.meta.url),
    "utf8",
  ),
);
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: cfg.port,
  user: "seatraces",
  password: cfg.password,
  database: "seatraces",
  max: 2,
  options: "-c search_path=" + schema + ",public",
});
pool.on("error", () => {});
const query = (...args) => pool.query(...args);
let peakHeap = 0,
  peakRss = 0,
  returnedBytes = 0;
const samples = [];
const sample = () => {
  const m = process.memoryUsage();
  peakHeap = Math.max(peakHeap, m.heapUsed);
  peakRss = Math.max(peakRss, m.rss);
};
const timer = setInterval(sample, 5);
try {
  if (mode === "before") {
    const first = (
      await query("SELECT * FROM journey_sessions WHERE id=$1 AND user_id=$2", [
        sessionId,
        userId,
      ])
    ).rows[0];
    const second = (
      await query("SELECT * FROM journey_sessions WHERE id=$1 AND user_id=$2", [
        sessionId,
        userId,
      ])
    ).rows[0];
    sample();
    console.log(
      JSON.stringify({
        copies: 2,
        places:
          first.catalog.a.clusters[0].members.length +
          second.catalog.a.clusters[0].members.length,
        peakHeapMB: Math.ceil(peakHeap / 1048576),
      }),
    );
  } else {
    const cities = [{ id: "a", name: "测试城", timezone: "Asia/Shanghai" }];
    const draft = createJourneyDraft({
      model: async (_, data) => ({
        days: data.dates.map((date) => ({
          date,
          places: data.candidates.slice(0, 3).map((c) => c.ref),
        })),
      }),
      opening: async () => ({ status: "unknown", dayState: "unknown" }),
    });
    for (let i = 0; i < 8; i++) {
      const started = performance.now();
      const pools = await planningPools({
        query,
        sessionId,
        userId,
        cities,
        selections: { a: ["x"] },
        wishes: { child5000: true },
      });
      sample();
      returnedBytes = Math.max(
        returnedBytes,
        Buffer.byteLength(JSON.stringify(pools)),
      );
      const plan = await draft(
        { start: "2026-11-01", end: "2026-11-01" },
        cities,
        pools,
        { interests: [], pace: "balanced", revisit: "either" },
      );
      if (
        plan.days.length !== 1 ||
        !plan.days[0].stops.length ||
        !pools.a.find((p) => p.id === "p5000" && p.wanted)
      )
        throw Error("draft/wish lost");
      sample();
      samples.push(performance.now() - started);
    }
    console.log(
      JSON.stringify({
        drafts: 8,
        regularCandidates: 60,
        wishedCandidates: 1,
        returnedBytes,
        heapLimitMB: Math.round(
          v8.getHeapStatistics().heap_size_limit / 1048576,
        ),
        peakHeapMB: Math.ceil(peakHeap / 1048576),
        peakRssMB: Math.ceil(peakRss / 1048576),
        maxMilliseconds: Math.ceil(Math.max(...samples)),
      }),
    );
  }
} finally {
  clearInterval(timer);
  await pool.end();
}
