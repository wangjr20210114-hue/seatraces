import test from "node:test";
import assert from "node:assert/strict";
import {
  groupScenicEntities,
  representedIds,
  applyWishes,
  clusterInventory,
} from "../server/domain/scenic-entities.mjs";
import { clusterScenicPlaces } from "../server/domain/scenic-clusters.mjs";
import {
  selectedPools,
  enrichCandidate,
  mergeVisits,
} from "../server/services/journey-service.mjs";
import { createJourneyDraft } from "../server/services/journey-draft.mjs";
import { inferPresence } from "../server/domain/place-presence.mjs";
const p = (id, name = id, extra = {}) => ({
  id,
  name,
  lat: 31,
  lng: 120,
  category: "attraction",
  traits: {},
  ...extra,
});
test("numeric aliases, generic labels and distinct campuses never prove duplication", () => {
  const input = [
    p("a", "景点甲", { aliases: ["1"] }),
    p("b", "景点乙", { aliases: ["1"] }),
    p("c", "三顷园西园", { aliases: ["三顷园"] }),
    p("d", "三顷园东园", { aliases: ["三顷园"] }),
    p("e", "景观"),
    p("f", "景观"),
  ];
  assert.equal(groupScenicEntities(input).length, 6);
});
test("scenic-area grouping preserves each source, separates independent nearby sights and distant namesakes", () => {
  const input = [
    p("area", "山水景区"),
    p("duplicate", "山水景区", { lat: 31.0001 }),
    p("child", "山水景区·古亭", { lat: 31.001 }),
    p("independent", "另一座博物馆"),
    p("remote", "山水景区", { lat: 32 }),
  ];
  const before = structuredClone(input),
    result = groupScenicEntities(input);
  assert.deepEqual(input, before);
  assert.equal(result.length, 3);
  assert.equal(result[0].children[0].id, "child");
  assert.deepEqual(
    [...new Set(result.flatMap(representedIds))].sort(),
    input.map((p) => p.id).sort(),
  );
  assert.equal(result[0].sourceRecords.length, 2);
  const wished = applyWishes(result[0], { child: true });
  assert.equal(wished.wanted, true);
  assert.equal(wished.ownWanted, false);
  assert.equal(wished.children[0].ownWanted, true);
  assert.equal(applyWishes(wished, {}).wanted, false);
});
test("large cities keep all source IDs after clustering, while small towns need fewer areas", () => {
  const big = Array.from({ length: 1500 }, (_, i) =>
    p(String(i), `景点${i}`, {
      lat: 31 + (i % 40) * 0.005,
      lng: 120 + Math.floor(i / 40) * 0.005,
    }),
  );
  big.push({ ...big[0], id: "duplicate" });
  const groups = clusterScenicPlaces(big),
    inventory = clusterInventory(groups);
  assert.ok(groups.length >= 8 && groups.length <= 12);
  assert.equal(inventory.sourceRecordCount, 1501);
  assert.equal(inventory.placeCount, 1500);
  assert.ok(clusterScenicPlaces(big.slice(0, 45)).length < 8);
});
test("a low-ranked wish and wished child survive the shortlist and fresh details", () => {
  const members = Array.from({ length: 300 }, (_, i) => p(String(i)));
  members[298].children = [p("child")];
  const pool = selectedPools(
    { a: { clusters: [{ id: "x", members }] } },
    { a: ["x"] },
    [{ id: "a" }],
    { 299: true, child: true },
  ).a;
  assert.equal(pool.length, 62);
  assert.ok(pool.find((p) => p.id === "299").wanted);
  assert.ok(pool.find((p) => p.id === "298").wanted);
  const detailed = enrichCandidate(
    pool[0],
    { wanted: false, children: [] },
    {},
    {},
  );
  assert.equal(detailed.wanted, true);
  assert.equal(detailed.children.length, 1);
});
test("feasible wishes override model omission and prior visit; closed wishes remain explicitly unplanned", async () => {
  let sent;
  const draft = createJourneyDraft({
    model: async (_, data) => {
      sent = data;
      return {
        days: data.dates.map((date) => ({
          date,
          places: [data.candidates.find((p) => p.name === "普通景点").ref],
        })),
      };
    },
    opening: async (p) =>
      p.id === "closed"
        ? { status: "parsed", dayState: "closed", intervals: [] }
        : { status: "unknown" },
  });
  const result = await draft(
    { start: "2026-11-12", end: "2026-11-12" },
    [{ id: "a", name: "测试城" }],
    {
      a: [
        p("normal", "普通景点"),
        p("wish", "想去景点", { wanted: true, visited: true }),
        p("closed", "闭馆景点", { wanted: true }),
      ],
    },
    { pace: "relaxed", revisit: "new" },
  );
  assert.ok(sent.candidates.find((p) => p.name === "想去景点").wanted);
  assert.deepEqual(
    new Set(result.days[0].stops.map((p) => p.id)),
    new Set(["wish", "normal"]),
  );
  assert.equal(result.wishes.requested, 2);
  assert.equal(result.wishes.scheduled, 1);
  assert.equal(result.wishes.unscheduled[0].id, "closed");
  assert.equal(result.wishes.unscheduled[0].reason, "closed_on_selected_dates");
});
test("too many wishes remain in the result rather than being silently dropped", async () => {
  const draft = createJourneyDraft({
    model: async (_, data) => ({
      days: data.dates.map((date) => ({ date, places: [] })),
    }),
    opening: async () => ({ status: "unknown" }),
  });
  const result = await draft(
    { start: "2026-11-12", end: "2026-11-12" },
    [{ id: "a", name: "测试城" }],
    {
      a: Array.from({ length: 80 }, (_, i) =>
        p(String(i), String(i), { wanted: true }),
      ),
    },
    { pace: "relaxed", revisit: "new" },
  );
  assert.equal(result.wishes.requested, 80);
  assert.ok(result.wishes.scheduled > 3);
  assert.ok(result.wishes.scheduled < 80);
  assert.equal(result.wishes.unscheduled.length + result.wishes.scheduled, 80);
  assert.ok(result.days[0].stops.at(-1).leave <= "17:00");
});
test("wish priority preserves future-day assignments and spreads omitted wishes across days", async () => {
  const pool = {
    a: [
      p("wish-a", "意愿甲", { wanted: true }),
      p("wish-b", "意愿乙", { wanted: true }),
      p("extra", "其他景点"),
    ],
  };
  for (const omit of [false, true]) {
    const draft = createJourneyDraft({
      model: async (_, data) => ({
        days: data.dates.map((date, i) => ({
          date,
          places: omit
            ? []
            : [
                data.candidates.find(
                  (p) => p.name === (i ? "意愿乙" : "意愿甲"),
                ).ref,
              ],
        })),
      }),
      opening: async () => ({ status: "unknown" }),
    });
    const result = await draft(
      { start: "2026-11-12", end: "2026-11-13" },
      [{ id: "a", name: "测试城" }],
      pool,
      { pace: "relaxed", revisit: "new" },
    );
    assert.deepEqual(
      result.days.map((d) => d.stops.map((p) => p.id)),
      [["wish-a"], ["wish-b"]],
    );
    assert.equal(result.wishes.scheduled, 2);
  }
});
test("location inference requires sustained accurate presence; passing, stale, ambiguous or interrupted tracks do not count", () => {
  const now = Date.now(),
    samples = Array.from({ length: 11 }, (_, i) => ({
      lat: 31,
      lng: 120,
      accuracy: 20,
      at: now - (10 - i) * 60000,
    }));
  const result = inferPresence([p("a")], samples, now);
  assert.equal(result[0].source, "location_dwell");
  assert.equal(result[0].dwellSeconds, 600);
  assert.deepEqual(inferPresence([p("a")], samples.slice(-5), now), []);
  assert.deepEqual(
    inferPresence(
      [p("a")],
      samples.map((s) => ({ ...s, accuracy: 150 })),
      now,
    ),
    [],
  );
  assert.deepEqual(inferPresence([p("a"), p("b")], samples, now), []);
  assert.deepEqual(inferPresence([p("a")], samples, now + 180000), []);
  assert.deepEqual(
    inferPresence(
      [p("a")],
      samples.filter((_, i) => i < 2 || i > 5),
      now,
    ),
    [],
  );
  assert.deepEqual(
    inferPresence(
      [p("a")],
      samples.map((s, i) => ({ ...s, lat: i === 0 ? 32 : s.lat })),
      now,
    ),
    [],
  );
  const v = mergeVisits(
    [],
    [],
    [{ place_id: "a", observed_at: "2026-10-11", dwell_seconds: 600 }],
  );
  assert.equal(v.a.status, "inferred");
  assert.equal(v.a.source, "location_dwell");
});
