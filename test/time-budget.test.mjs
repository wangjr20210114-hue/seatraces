import test from "node:test";
import assert from "node:assert/strict";
import { createJourneyDraft } from "../server/services/journey-draft.mjs";
import { routeTiming } from "../server/services/journey-service.mjs";
import { visitAllowance } from "../server/domain/day-budget.mjs";
import { schematicConnections } from "../public/route-curves.js";
import { createDeepseekClient } from "../server/integrations/deepseek.mjs";

const points = (spacing = 0.001, tourism = "artwork") =>
  Array.from({ length: 10 }, (_, i) => ({
    id: `test:${i}`,
    name: `独立景点${i}`,
    category: "attraction",
    lat: 30 + i * spacing,
    lng: 120,
    traits: { tourism },
    wanted: true,
  }));
const draft = createJourneyDraft({
  model: createDeepseekClient({
    env: { DEEPSEEK_API_KEY: "synthetic-test-only" },
    requestJSON: async (_provider, _url, options) => {
      const d = JSON.parse(JSON.parse(options.body).messages[1].content);
      return {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                days: d.dates.map((date) => ({
                  date,
                  places: d.candidates.map((p) => p.ref),
                })),
              }),
            },
          },
        ],
      };
    },
  }),
  opening: async () => ({ status: "unknown" }),
});
const make = (places, pace = "balanced", origin) =>
  draft(
    { start: "2026-11-14", end: "2026-11-14", origin },
    [{ id: "city", name: "测试城", lat: 30, lng: 120 }],
    { city: places },
    { pace, revisit: "new" },
  );

test("nearby short visits can exceed three; distance and long stays reduce what fits", async () => {
  const near = await make(points()),
    far = await make(points(0.25)),
    museums = await make(points(0.001, "museum"));
  assert.equal(near.days[0].stops.length, 10);
  assert.ok(far.days[0].stops.length < near.days[0].stops.length);
  assert.ok(museums.days[0].stops.length < near.days[0].stops.length);
  for (const plan of [near, far, museums]) {
    assert.ok(plan.days[0].stops.at(-1).leave <= "18:00");
    assert.equal(plan.wishes.scheduled + plan.wishes.unscheduled.length, 10);
    assert.equal(plan.days[0].stops[0].durationSource, "planning_allowance");
  }
});

test("pace changes time budget, including cross-city afternoons without a two-stop cap", async () => {
  const relaxed = await make(points(0.001, "museum"), "relaxed");
  const full = await make(points(0.001, "museum"), "full");
  assert.ok(full.days[0].stops.length > relaxed.days[0].stops.length);
  const afternoon = await make(points(), "balanced", { label: "另一座城" });
  assert.ok(afternoon.days[0].stops.length > 3);
  assert.equal(afternoon.days[0].stops[0].arrive, "14:00");
  assert.ok(afternoon.days[0].stops.at(-1).leave <= "18:00");
});

test("expired or unsourced durations remain estimates; valid evidence can supply duration", () => {
  const p = points()[0];
  const sourced = {
    value: 45,
    sourceUrl: "https://example.test/official",
    status: "fresh",
  };
  assert.deepEqual(visitAllowance({ ...p, facts: { stayMinutes: sourced } }), {
    minutes: 45,
    source: "sourced",
  });
  for (const fact of [
    { ...sourced, status: "expired" },
    { ...sourced, expiresAt: "2000-01-01" },
    { value: 5 },
  ])
    assert.deepEqual(visitAllowance({ ...p, facts: { stayMinutes: fact } }), {
      minutes: 20,
      source: "planning_allowance",
    });
});

test("real route timing uses the same breaks and flags overrun or missing duration", async () => {
  const day = (await make(points())).days[0];
  const legs = day.stops
    .slice(1)
    .map((p) => ({ status: "live", minutes: p.travelMin }));
  const timed = await routeTiming(day, legs, async () => ({
    status: "unknown",
  }));
  assert.deepEqual(
    timed.stops.map((p) => [p.arrive, p.leave]),
    day.stops.map((p) => [p.arrive, p.leave]),
  );
  const overrun = await routeTiming(
    day,
    legs.map((l) => ({ ...l, minutes: 120 })),
    async () => ({ status: "unknown" }),
  );
  assert.ok(overrun.warnings.some((w) => w.includes("满")));
  const missing = await routeTiming(
    day,
    legs.map((l) => ({ ...l, minutes: null })),
    async () => ({ status: "unknown" }),
  );
  assert.equal(missing.stops.length, 0);
});

test("illustrative curves retain visit order even with complete road geometry", () => {
  const stops = [
    { id: "a", position: [120, 30] },
    { id: "b", position: [120.1, 30.1] },
    { id: "c", position: [120.2, 30] },
  ];
  const curves = schematicConnections(stops);
  assert.equal(curves.length, 2);
  assert.equal(curves[0].source, "schematic");
  assert.deepEqual(curves[0].path[0], stops[0].position);
  assert.ok(Math.abs(curves[0].path.at(-1)[0] - 120.1) < 1e-9);
  const live = {
    from: "a",
    to: "b",
    status: "live",
    segments: [
      {
        mapPolyline: [
          [120, 30],
          [120.1, 30.1],
        ],
      },
    ],
  };
  assert.equal(schematicConnections(stops, [live]).length, 2);
  assert.equal(
    schematicConnections(stops, [{ ...live, segments: [] }]).length,
    2,
  );
});
