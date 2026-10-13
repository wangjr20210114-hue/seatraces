// Authorized five-city batch, round-robin chunks are checkpoints, not total caps.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import dotenv from "dotenv";
const root = new URL("../", import.meta.url),
  runtime = new URL(".runtime/five-city-parents/", root);
dotenv.config({ path: new URL(".env", root), quiet: true });
const args = process.argv.slice(2);
if (
  args.some((a) => !["--prepare", "--run", "--status"].includes(a)) ||
  args.length !== 1
)
  throw Error("Use --prepare, --run or --status");
if (args[0] === "--status") {
  console.log(await readFile(new URL("status.json", runtime), "utf8"));
  process.exit(0);
}
const local = JSON.parse(
  await readFile(new URL(".runtime/local.json", root), "utf8"),
);
process.env.DATABASE_URL = `postgresql://seatraces:${encodeURIComponent(local.password)}@127.0.0.1:${local.port}/seatraces`;
process.env.AMAP_PARENT_LOOKUP_ENABLED = "false";
process.env.AMAP_BATCH_MODE = "parent_catalog";
const { query, pool, migrate } = await import("../server/db.mjs");
const { cityCatalog } = await import("../server/services/city-clusters.mjs");
const { parentEnricher, currentParentHierarchy } = await import(
  "../server/services/scenic-parents.mjs"
);
const { visitable, clusterScenicPlaces } = await import(
  "../server/domain/scenic-clusters.mjs"
);
const { clusterInventory } = await import(
  "../server/domain/scenic-entities.mjs"
);
await mkdir(runtime, { recursive: true });
const plans = [
  ["beijing", "北京"],
  ["shanghai", "上海"],
  ["gn-1809858", "广州"],
  ["gn-1795565", "深圳"],
  ["hangzhou", "杭州"],
];
const status = {
  version: 1,
  at: new Date().toISOString(),
  status: "preparing",
  cities: [],
  moneyReservePerCall: Number(
    process.env.AMAP_PARENT_REQUEST_RESERVE_CNY || 0.003,
  ),
  applicationCountCap: null,
};
async function saveStatus() {
  status.at = new Date().toISOString();
  const out = new URL("status.json", runtime),
    tmp = new URL("status.tmp", runtime);
  await writeFile(tmp, JSON.stringify(status, null, 2));
  await rename(tmp, out);
}
async function loadCity(id, name) {
  const file = new URL(id + ".json", runtime);
  try {
    const existing = JSON.parse(await readFile(file, "utf8"));
    if (
      existing.version === 3 &&
      existing.coverage.scope === "city_boundary" &&
      Date.now() - Date.parse(existing.at) < 86400_000
    )
      return existing;
  } catch {}
  const city = (
    await query("SELECT * FROM places WHERE id=$1 AND category='city'", [id])
  ).rows[0];
  if (!city) throw Error("City missing: " + name);
  city.name = name;
  const base = await cityCatalog(city);
  const data = {
    version: 3,
    at: new Date().toISOString(),
    city,
    coverage: base.coverage,
    places: base.places.filter(visitable),
  };
  await writeFile(file, JSON.stringify(data));
  return data;
}
try {
  await migrate();
  // Correct the imported GeoNames canonical city label while preserving its ID/aliases.
  await query(
    "UPDATE places SET aliases=ARRAY(SELECT DISTINCT unnest(aliases || ARRAY[name,'深圳','深圳市'])),name='深圳',search_text=search_text || ' 深圳 深圳市',updated_at=now() WHERE id='gn-1795565' AND category='city' AND name<>'深圳'",
  );
  const loaded = [];
  for (const [id, name] of plans) {
    try {
      const data = await loadCity(id, name);
      data.places = data.places.map((p) => ({
        ...p,
        mainlandCityVerified:
          data.city.country === "CN" && data.coverage.scope === "city_boundary",
      }));
      loaded.push(data);
      const current = await currentParentHierarchy(data.places);
      status.cities.push({
        id,
        name,
        coverage: data.coverage,
        ...current.coverage,
      });
      console.log(
        JSON.stringify({
          prepared: name,
          ...current.coverage,
          coverage: data.coverage,
        }),
      );
    } catch (e) {
      status.cities.push({
        id,
        name,
        status: "source_unavailable",
        error: e.code || "source_unavailable",
      });
    }
    await saveStatus();
  }
  if (args[0] === "--prepare") {
    status.status = "prepared";
    await saveStatus();
  } else {
    status.status = "running";
    await saveStatus();
    let keepGoing = true;
    while (keepGoing) {
      keepGoing = false;
      for (const data of loaded) {
        const row = status.cities.find((c) => c.id === data.city.id);
        if (row.pending === 0) continue;
        status.activeCity = data.city.name;
        await saveStatus();
        const result = await parentEnricher.run(data.places, {
          maxCalls: 100,
          onProgress: async (p) => {
            Object.assign(row, {
              batchProcessed: p.processed,
              batchAttempts: p.calls,
            });
            if (p.processed % 10 === 0) {
              await saveStatus();
              console.log(JSON.stringify({ city: data.city.name, ...p }));
            }
          },
        });
        Object.assign(row, result.report);
        const clusters = clusterScenicPlaces(result.places);
        row.inventory = clusterInventory(clusters);
        const parentExamples = clusters.flatMap((c) =>
          c.members
            .filter((p) => p.children.length)
            .map((p) => ({
              id: p.id,
              name: p.name,
              children: p.children.map((c) => ({ id: c.id, name: c.name })),
            })),
        );
        await writeFile(
          new URL("validation/amap-parent-" + data.city.id + ".json", root),
          JSON.stringify(
            {
              at: new Date().toISOString(),
              report: row,
              parents: parentExamples,
            },
            null,
            2,
          ),
        );
        await saveStatus();
        console.log(
          JSON.stringify({ batchFinished: data.city.name, report: row }),
        );
        if (result.report.paused && result.report.paused !== "batch_limit") {
          status.status = "paused";
          status.reason = result.report.paused;
          keepGoing = false;
          await saveStatus();
          break;
        }
        if (row.pending > 0) keepGoing = true;
      }
      if (status.status === "paused") break;
    }
    if (status.status !== "paused")
      status.status = status.cities.every(
        (c) =>
          c.pending === 0 &&
          c.unresolved === 0 &&
          c.coverage?.scope === "city_boundary" &&
          c.coverage?.status !== "bounded_sample",
      )
        ? "complete"
        : "review_needed";
    delete status.activeCity;
    await saveStatus();
  }
  console.log(JSON.stringify(status));
} catch(error) {
  status.status='paused';status.reason='batch_error';
  status.errorCode=/^[A-Z0-9_]+$/i.test(error.code || '') ? error.code : 'operation_failed';
  await saveStatus();
  console.error(JSON.stringify({status:status.status,reason:status.reason,code:status.errorCode}));
  process.exitCode=1;
} finally {
  await pool.end();
}
