import test from "node:test";
import assert from "node:assert/strict";
import {
  clusterScenicPlaces,
  scorePlace,
  clusterRules,
} from "../server/domain/scenic-clusters.mjs";
import { distance } from "../server/planner.mjs";
import {
  allocateDates,
  validateDaySelection,
  createJourneyDraft,
} from "../server/services/journey-draft.mjs";
import {
  journeyRequest,
  selectedPools,
  mergeVisits,
  routeTiming,
} from "../server/services/journey-service.mjs";
import {
  contains,
  ringBounds,
  cityBoundingBox,
} from "../server/services/city-boundaries.mjs";
const point = (i, lat = 31 + i * 0.006) => ({
  id: "osm:node/" + i,
  name: "景点" + i,
  lat,
  lng: 121,
  category: "attraction",
  traits: { tourism: "museum" },
  city: "测试城",
  country: "CN",
});
test("city areas preserve candidates, have unique numbers and exact POI anchors", () => {
  const input = Array.from({ length: 1800 }, (_, i) => ({
    ...point(i, 31 + (i % 60) * 0.006),
    lng: 121 + Math.floor(i / 60) * 0.006,
  }));
  const groups = clusterScenicPlaces(input);
  assert.equal(groups.flatMap((g) => g.members).length, input.length);
  assert.ok(groups.length >= 8 && groups.length <= clusterRules.maxClusters);
  assert.deepEqual(
    groups.map((g) => g.number),
    Array.from({ length: groups.length }, (_, i) => i + 1),
  );
  assert.deepEqual(
    groups.map((g) => g.id).sort(),
    clusterScenicPlaces(input.toReversed())
      .map((g) => g.id)
      .sort(),
  );
  for (const g of groups) {
    assert.equal(
      g.score,
      g.members.reduce((s, p) => s + p.score.total, 0),
    );
    const anchor = g.members.find((p) => p.id === g.anchor.id);
    assert.equal(g.anchor.lat, anchor.lat);
    assert.equal(g.anchor.lng, anchor.lng);
    assert.equal(g.name, anchor.name + "一带");
  }
});
test("small towns and coincident points never make empty clusters", () => {
  assert.equal(clusterScenicPlaces([]).length, 0);
  assert.equal(clusterScenicPlaces([point(1), point(2)]).length, 1);
  const groups = clusterScenicPlaces(
    Array.from({ length: 50 }, (_, i) => point(i, 31)),
  );
  assert.equal(groups.length, 1);
  assert.equal(groups.flatMap((g) => g.members).length, 50);
  assert.ok(groups.every((g) => g.memberCount > 0));
});
test("duplicate labels near each other merge representations; distant homonyms stay", () => {
  const points = [
    point(1),
    { ...point(2, 31.0061), name: "景点1" },
    { ...point(3, 32), name: "景点1" },
  ];
  assert.equal(clusterScenicPlaces(points).flatMap((g) => g.members).length, 2);
});
test("missing and expired crowd data add no penalty; preference scales sourced data", () => {
  const p = point(1),
    signal = {
      crowd: {
        value: 1,
        sourceUrl: "https://example.org/source",
        expiresAt: "2099-01-01",
      },
    };
  assert.equal(scorePlace(p).parts.crowd, 0);
  assert.equal(
    scorePlace(p, {}, { crowd: { ...signal.crowd, expiresAt: "2000-01-01" } })
      .parts.crowd,
    0,
  );
  assert.ok(
    scorePlace(p, { crowd: "avoid" }, signal).total <
      scorePlace(p, { crowd: "lively" }, signal).total,
  );
  assert.equal(scorePlace(p).coverage.fame, "missing");
});
test("city boundaries contain points and large vertex sets do not overflow", () => {
  const ring = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
    [0, 0],
  ];
  assert.ok(contains([1, 1], [ring]));
  assert.ok(!contains([3, 1], [ring]));
  assert.deepEqual(
    ringBounds([Array.from({ length: 150000 }, () => [1, 2])]),
    [1, 2, 1, 2],
  );
  assert.ok(
    cityBoundingBox({ lat: 31, lng: 121 }, { cityRings: [] }).west < 121,
  );
});
test("five-city limit, real dates, selected order, and transfer allocations", () => {
  assert.throws(() =>
    journeyRequest.parse({
      origin: { label: "起点" },
      cityIds: ["1", "2", "3", "4", "5", "6"],
      start: "2026-11-01",
      end: "2026-11-09",
    }),
  );
  assert.throws(() =>
    allocateDates({ start: "2026-02-30", end: "2026-03-04" }, [{ id: "a" }]),
  );
  assert.throws(() =>
    allocateDates({ start: "2026-11-01", end: "2026-11-01" }, [
      { id: "a" },
      { id: "b" },
    ]),
  );
  const a = allocateDates({ start: "2026-11-01", end: "2026-11-05" }, [
    { id: "a" },
    { id: "b" },
  ]);
  assert.deepEqual(
    a.map((x) => x.city.id),
    ["a", "b"],
  );
  assert.equal(a[1].transfer, true);
  assert.equal(a.flatMap((x) => x.dates).length, 5);
});
test("LLM cannot introduce outside places, repeated IDs or extra dates", () => {
  const p = { ...point(1), ref: "p0" },
    d = ["2026-11-01"];
  assert.throws(() =>
    validateDaySelection(
      { days: [{ date: d[0], places: ["invented"] }] },
      d,
      [p],
      new Set(),
      3,
    ),
  );
  assert.throws(() =>
    validateDaySelection(
      { days: [{ date: d[0], places: ["p0", "p0"] }] },
      d,
      [p],
      new Set(),
      3,
    ),
  );
  assert.throws(() =>
    validateDaySelection(
      { days: [{ date: "2026-11-02", places: ["p0"] }] },
      d,
      [p],
      new Set(),
      3,
    ),
  );
});
test("selected pools must belong to each session and draw from multiple selected groups", () => {
  const catalog = {
    a: {
      clusters: [
        { id: "x", members: [point(1), point(2)] },
        { id: "y", members: [point(3)] },
      ],
    },
  };
  assert.throws(() =>
    selectedPools(catalog, { a: ["foreign"] }, [{ id: "a" }]),
  );
  assert.deepEqual(
    selectedPools(catalog, { a: ["x", "y"] }, [{ id: "a" }]).a.map((p) => p.id),
    ["osm:node/1", "osm:node/3", "osm:node/2"],
  );
});
test("explicit not-visited overrides completed history; planned trips are not input", () => {
  const v = mergeVisits(
    [{ plan: { days: [{ date: "2026-01-01", stops: [point(1)] }] } }],
    [
      { place_id: "osm:node/1", visited: false },
      { place_id: "osm:node/2", visited: true },
    ],
  );
  assert.ok(!v["osm:node/1"]);
  assert.equal(v["osm:node/2"].source, "user_confirmed");
});
test("draft excludes visited candidates and handles official closure without fabrication", async () => {
  let provided;
  const draft = createJourneyDraft({
    model: async (_, data) => {
      provided = data;
      return {
        days: data.dates.map((date) => ({
          date,
          places: data.candidates.map((c) => c.ref),
        })),
      };
    },
    opening: async (p) =>
      p.id === "osm:node/2"
        ? { status: "parsed", dayState: "closed", intervals: [] }
        : { status: "unknown", dayState: "unknown" },
  });
  const plan = await draft(
    { start: "2026-11-01", end: "2026-11-01" },
    [{ id: "a", name: "测试城" }],
    { a: [{ ...point(1), visited: true }, point(2), point(3)] },
    { pace: "balanced", revisit: "new" },
  );
  assert.equal(provided.candidates.length, 2);
  assert.deepEqual(
    plan.days[0].stops.map((p) => p.id),
    ["osm:node/3"],
  );
  assert.equal(plan.days[0].stops[0].timingStatus, "draft");
});
test("route time failures preserve draft and closure conflicts are exposed", async () => {
  const day = {
    date: "2026-11-01",
    stops: [
      { ...point(1), duration_min: 90 },
      { ...point(2), duration_min: 90 },
    ],
  };
  const missing = await routeTiming(
    day,
    [{ status: "unresolved" }],
    async () => ({ status: "unknown" }),
  );
  assert.equal(missing.stops.length, 0);
  assert.ok(missing.warnings.length);
  const closed = await routeTiming(
    day,
    [{ status: "live", minutes: 20 }],
    async () => ({ status: "parsed", dayState: "closed", intervals: [] }),
  );
  assert.equal(closed.warnings.length, 2);
});
