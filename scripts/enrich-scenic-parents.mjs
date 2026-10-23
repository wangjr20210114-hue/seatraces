/* 补充并核验指定城市的景区主体地点。 */

import { readFile, writeFile } from "node:fs/promises";
import dotenv from "dotenv";
const root = new URL("../", import.meta.url);
dotenv.config({ path: new URL(".env", root), quiet: true });
const args = process.argv.slice(2);
const cityName = args.find((a) => a.startsWith("--city="))?.slice(7);
const pilot = args.includes("--pilot"),
  live = args.includes("--live");
const maxCalls = args.some((a) => a.startsWith("--max-calls="))
  ? Number(args.find((a) => a.startsWith("--max-calls=")).slice(12))
  : Infinity;
if (
  (!pilot && !cityName) ||
  (pilot && cityName) ||
  (maxCalls !== Infinity && !Number.isSafeInteger(maxCalls)) ||
  maxCalls < 1 ||
  args.some(
    (a) =>
      !["--pilot", "--live"].includes(a) &&
      !a.startsWith("--city=") &&
      !a.startsWith("--max-calls="),
  )
) {
  throw Error(
    "Usage: node scripts/enrich-scenic-parents.mjs (--pilot | --city=北京市) [--live] [--max-calls=20]",
  );
}
const local = JSON.parse(
  await readFile(new URL(".runtime/local.json", root), "utf8"),
);
process.env.DATABASE_URL = `postgresql://seatraces:${encodeURIComponent(local.password)}@127.0.0.1:${local.port}/seatraces`;
process.env.AMAP_PARENT_LOOKUP_ENABLED = "false";
const { pool, migrate, query } = await import("../server/db.mjs");
try {
  await migrate();
  const { parentEnricher, currentParentHierarchy } = await import(
    "../server/services/scenic-parents.mjs"
  );
  const { clusterScenicPlaces } = await import(
    "../server/domain/scenic-clusters.mjs"
  );
  const { clusterInventory } = await import(
    "../server/domain/scenic-entities.mjs"
  );
  let points;
  if (pilot) {
    const saved = JSON.parse(
      await readFile(
        new URL(".runtime/palace-evidence-20261012/catalog.json", root),
        "utf8",
      ),
    );
    points = saved.items
      .filter((p) =>
        [
          "故宫",
          "故宫博物院",
          "太和殿",
          "中和殿",
          "保和殿",
          "乾清宫",
          "御花园",
          "景山公园",
          "北海公园",
        ].includes(p.name),
      )
      .map((p) => ({
        ...p,
        city: "北京市",
        country: "CN",
        timezone: "Asia/Shanghai",
      }));
  } else {
    const city = (
      await query(
        "SELECT * FROM places WHERE category='city' AND (name=$1 OR id=$1) LIMIT 1",
        [cityName],
      )
    ).rows[0];
    if (!city) throw Error("City not found in local catalog");
    if (!live) {
      console.log(
        JSON.stringify({
          city: city.name,
          mode: "configuration_only",
          message:
            "Add --live to load this city and process all candidates within the call limit.",
        }),
      );
      process.exitCode = 0;
    } else {
      const { cityCatalog } = await import(
        "../server/services/city-clusters.mjs"
      );
      const base = await cityCatalog(city);
      points = base.places;
    }
  }
  if (points) {
    const result = live
      ? await parentEnricher.run(points, {
          maxCalls,
          onProgress: (p) => console.log(JSON.stringify({ progress: p })),
        })
      : await currentParentHierarchy(points);
    const groups = clusterScenicPlaces(result.places);
    const report = {
      at: new Date().toISOString(),
      mode: live ? "live" : "stored_only",
      scope: pilot ? "palace_pilot" : cityName,
      report: result.report || result.coverage,
      inventory: clusterInventory(groups),
      places: groups.flatMap((c) =>
        c.members.map((p) => ({
          id: p.id,
          name: p.name,
          level: p.hierarchyLevel,
          status: p.parentLookup?.status,
          children: p.children.map((x) => ({
            id: x.id,
            name: x.name,
            level: x.hierarchyLevel,
            evidence: x.groupingEvidence,
          })),
        })),
      ),
    };
    await writeFile(
      new URL("validation/amap-parent-latest.json", root),
      JSON.stringify(report, null, 2),
    );
    await writeFile(
      new URL(
        `validation/amap-parent-${pilot ? "pilot" : "city"}-${live ? "live" : "stored"}.json`,
        root,
      ),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify(
        pilot
          ? report
          : {
              ...report,
              places: report.places.filter((p) => p.children.length),
            },
      ),
    );
  }
} finally {
  await pool.end();
}
