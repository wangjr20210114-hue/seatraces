import test from "node:test";
import assert from "node:assert/strict";
import { createParentEnricher } from "../server/services/scenic-parents.mjs";
import {
  readParent,
  overlayParentChecks,
  selectParentPoi,
} from "../server/domain/amap-parent.mjs";
import {
  groupScenicEntities,
  representedIds,
} from "../server/domain/scenic-entities.mjs";
import { toGcj, mainlandEligible } from "../public/coordinates.js";
import { readCityPlaces } from "../server/services/city-clusters.mjs";
import { createApiReservation } from "../server/repositories/api-usage.mjs";
const p = (id, name, extra = {}) => ({
  id,
  name,
  lat: 39.916,
  lng: 116.39,
  country: "CN",
  category: "attraction",
  traits: {},
  ...extra,
});
const poi = (id, name, parent = "", extra = {}) => ({
  id,
  name,
  parent,
  location: toGcj(p("x", "x")),
  ...extra,
});
const root = p("osm:r", "故宫"),
  child = p("osm:c", "太和殿"),
  independent = p("osm:i", "故宫-独立展馆");
function fixture(call) {
  const rows = new Map();
  const worker = createParentEnricher({
    call,
    load: async () => new Map(rows),
    save: async (p, r) => rows.set(p.id, r),
    catalog: async () => ({ items: [] }),
    env: { AMAP_KEY: "test" },
  });
  return { worker, rows };
}
test("empty parent, absent field and ambiguous identities remain distinct", () => {
  assert.equal(readParent({ parent: "" }).state, "none");
  assert.equal(readParent({ parent: [] }).state, "none");
  assert.equal(readParent({}).state, "unknown");
  assert.equal(
    selectParentPoi(child, [
      poi("B0001", "故宫-太和殿"),
      poi("B0002", "太和殿"),
    ]).status,
    "ambiguous",
  );
});
test("real parent IDs build two levels, empty parent defeats name heuristics, stored checks avoid all repeat calls", async () => {
  let calls = 0;
  const { worker } = fixture(async (path, args) => {
    calls++;
    if (path.endsWith("detail")) return { pois: [poi("BROOT", "故宫博物院")] };
    return {
      pois: [
        args.keywords === "太和殿"
          ? poi("BCHLD", "故宫博物院-太和殿", "BROOT")
          : args.keywords === "故宫"
            ? poi("BROOT", "故宫博物院")
            : poi("BINDE", "故宫-独立展馆"),
      ],
    };
  });
  const result = await worker.run([root, child, independent]);
  const grouped = groupScenicEntities(result.places),
    area = grouped.find((x) => x.id === root.id);
  assert.equal(area.children[0].id, child.id);
  assert.equal(area.children[0].groupingEvidence, "amap_parent");
  assert.ok(grouped.some((x) => x.id === independent.id));
  assert.deepEqual(
    [...new Set(grouped.flatMap(representedIds))].sort(),
    [root.id, child.id, independent.id].sort(),
  );
  const before = calls;
  await worker.run([root, child, independent]);
  assert.equal(calls, before);
});
test("missing parent is fetched and inserted once as a provider container; nested chains flatten", async () => {
  const a = p("osm:a", "东亭"),
    b = p("osm:b", "西亭", { lat: 39.9161 });
  let details = 0;
  const { worker } = fixture(async (path, args) => {
    if (path.endsWith("around"))
      return {
        pois: [
          poi(
            args.keywords === "东亭" ? "BCHD1" : "BCHD2",
            args.keywords,
            "BMIDD",
          ),
        ],
      };
    details++;
    return {
      pois: [
        args.id === "BMIDD"
          ? poi("BMIDD", "中园", "BROOT")
          : poi("BROOT", "大园"),
      ],
    };
  });
  const r = await worker.run([a, b]),
    groups = groupScenicEntities(r.places);
  assert.equal(details, 2);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, "amap:BROOT");
  assert.equal(groups[0].children.length, 2);
  assert.equal(r.report.children, 2);
});
test("failed calls, cycles, no matches and overseas do not become confirmed roots", async () => {
  const { worker } = fixture(async (path, args) => {
    if (args.keywords === "失败景点")
      throw Object.assign(Error("fail"), { status: 502 });
    if (args.keywords === "循环景点")
      return { pois: [poi("BCYCL", "循环景点", "BCYCL")] };
    return { pois: [] };
  });
  const r = await worker.run([
    p("a", "失败景点"),
    p("b", "循环景点"),
    p("c", "无匹配景点"),
    p("d", "境外景点", { country: "JP" }),
  ]);
  assert.equal(r.report.roots, 0);
  assert.equal(r.report.unsupported, 1);
  assert.equal(r.report.unresolved, 3);
  assert.equal(r.places.length, 4);
});
test("budget exhaustion preserves prior results and leaves unprocessed points pending", async () => {
  const { worker, rows } = fixture(async () => {
    throw Object.assign(Error("budget"), {
      status: 429,
      code: "local_monthly_budget",
    });
  });
  const r = await worker.run([root, child]);
  assert.equal(r.report.paused, "local_monthly_budget");
  assert.equal(rows.size, 0);
  assert.equal(r.report.pending, 2);
  const overlay = overlayParentChecks(
    [child],
    new Map([[child.id, { status: "failed" }]]),
  );
  assert.equal(overlay.places[0].parentLookup.status, "failed");
  assert.equal(overlay.places[0].hierarchyLevel, undefined);
});
test("authorized hierarchy batches have no local count cap", async () => {
  const make = (own, parent) =>
    createApiReservation({
      transact: async (fn) =>
        fn({
          query: async (sql, args) => {
            if (sql.includes("sum(reserved_cny)")) return { rows: [{ n: 0 }] };
            if (sql.includes("count(*)")) {
              assert.equal(args[0], "Amap");
              return { rows: [{ n: own, provider_n: own, parent_n: parent }] };
            }
            return { rows: [] };
          },
        }),
    });
  await make(100, 100)("AmapParent");
  await make(300, 50)("AmapParent");
  await make(100, 100)("Amap");
});
test("city candidate reads split truncated bounds and preserve all unique records", async () => {
  const boxes = [];
  const r = await readCityPlaces(
    { west: 0, east: 2, south: 0, north: 1 },
    async (path, box) => {
      boxes.push(box);
      return {
        status: "live",
        coverageStatus:
          box.east - box.west > 1 ? "bounded_sample" : "within_requested_bbox",
        items:
          box.east - box.west > 1
            ? [{ id: "discarded-sample" }]
            : [{ id: "boundary" }, { id: box.west === 0 ? "left" : "right" }],
      };
    },
  );
  assert.equal(boxes.length, 3);
  assert.deepEqual(r.items.map((p) => p.id).sort(), [
    "boundary",
    "left",
    "right",
  ]);
  assert.equal(r.coverageStatus, "within_requested_bbox");
});
test("a verified Shenzhen municipal polygon distinguishes mainland sights from the overlap guard", () => {
  const point = { lat: 22.54554, lng: 114.0683, country: "CN" };
  assert.equal(mainlandEligible(point), false);
  assert.equal(
    mainlandEligible({ ...point, mainlandCityVerified: true }),
    true,
  );
  assert.equal(
    mainlandEligible({ ...point, country: "HK", mainlandCityVerified: true }),
    false,
  );
});
