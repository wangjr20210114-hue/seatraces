import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  clusterWalkPlaces,
  validWalkPlace,
  uniqueWalkPlaces,
} from "../server/domain/walk-clusters.mjs";
import { nearbyWalkPlaces } from "../server/services/citywalk-catalog.mjs";
import { walkDistanceState } from "../server/services/citywalk-routing.mjs";
import { installCityWalkRoutes } from "../server/services/citywalk-service.mjs";
import { metres } from "../public/citywalk-route.js";
import { iterationFixture } from "./helpers/iteration-db.mjs";

const city = {
  id: "city-walk-qa",
  name: "测试城市",
  country: "CN",
  lat: 31,
  lng: 121,
};
const p = (id, x = 0, category = "attraction") => ({
  id,
  name: id,
  lat: 31,
  lng: 121 + x / 95000,
  category,
  country: "CN",
});
const points = [
  p("博物馆"),
  p("商场", 100, "shopping"),
  p("餐厅", 200, "food"),
];
test("walk clusters mix categories, bound chain radius and preserve unique membership", () => {
  const chain = Array.from({ length: 30 }, (_, i) => p("chain" + i, i * 300));
  const groups = clusterWalkPlaces([
    ...points,
    ...chain,
    points[0],
    p("isolated", 20000),
    p("hotel", 50, "lodging"),
    { ...p("private", 10), access: "private" },
  ]);
  const flat = groups.flatMap((g) => g.members);
  assert.equal(new Set(flat.map((p) => p.id)).size, flat.length);
  assert.ok(
    groups.some((g) =>
      ["food", "shopping", "attraction"].every((c) =>
        g.members.some((p) => p.category === c),
      ),
    ),
  );
  assert.ok(!flat.some((p) => ["isolated", "hotel", "private"].includes(p.id)));
  for (const g of groups) {
    assert.ok(g.members.every((p) => metres(p, g.anchor) <= 850));
    assert.ok(g.memberCount <= 60);
  }
  assert.equal(validWalkPlace({ ...points[0], lat: NaN }), false);
  assert.equal(
    uniqueWalkPlaces([
      p("a"),
      { ...p("b", 7), name: "a" },
      { ...p("c", 500), name: "a" },
    ]).length,
    2,
  );
});
test("walk grid handles 5000 candidate points in bounded groups", (t) => {
  const input = Array.from({ length: 5000 }, (_, i) => ({
    ...p("p" + i, (i % 100) * 100),
    lat: 31 + Math.floor(i / 100) * 0.001,
  }));
  const start = performance.now(),
    groups = clusterWalkPlaces(input),
    elapsed = Math.round(performance.now() - start);
  assert.ok(groups.length > 20);
  assert.ok(elapsed < 10000);
  t.diagnostic(
    JSON.stringify({
      points: input.length,
      groups: groups.length,
      elapsedMs: elapsed,
    }),
  );
});
test("nearby categories are filtered by actual coordinate proximity and access", async () => {
  const result = await nearbyWalkPlaces(points[0], city, async () => ({
    status: "live",
    items: [
      ...points,
      p("far", 2000),
      p("hotel", 20, "lodging"),
      { ...p("private"), access: "no" },
    ],
  }));
  assert.equal(result.length, 3);
  assert.ok(result.some((p) => p.category === "food"));
  await assert.rejects(
    nearbyWalkPlaces(points[0], city, async () => ({
      status: "unavailable",
      items: [],
    })),
    { status: 503 },
  );
});

test(
  "custom walk HTTP: owner isolation, next-place registration, distance limits, replay and conflicts",
  { skip: process.env.TEST_CITYWALK !== "1" },
  async (t) => {
    const f = await iterationFixture({
      schemas: ["citywalk-schema.sql", "citywalk-expansion-schema.sql"],
    });
    try {
      await f.query(
        "CREATE TABLE places(id text,name text,country text,province text,lat double precision,lng double precision,timezone text,category text)",
      );
      await f.query(
        "INSERT INTO places VALUES($1,$2,'CN','',31,121,'Asia/Shanghai','city')",
        [city.id, city.name],
      );
      let distance = 1200,
        unavailable = false,
        nearbyCalls = 0;
      installCityWalkRoutes(f.app, {
        ...f,
        loadCity: async () => ({
          city,
          clusters: [{ id: "area", members: points }],
        }),
        nearby: async (anchor) => {
          nearbyCalls++;
          return [p("near-" + anchor.id, 50, "shopping")];
        },
        verify: async () =>
          unavailable
            ? { status: "preview", distanceM: null, legs: [] }
            : {
                status: "verified",
                distanceM: distance,
                legs: [],
                ...walkDistanceState(distance),
              },
      });
      await f.start();
      const ready = async (path, body, user = "user") => {
        for (let i = 0; i < 80; i++) {
          const r = await f.request(path, { body, user });
          if (r.status !== 202) return r;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw Error("poll exceeded");
      };
      const draft = (await ready("/api/citywalk/catalog/" + city.id)).data;
      assert.ok(draft.draftId);
      const input = {
        id: randomUUID(),
        draftId: draft.draftId,
        title: "步行测试",
        clusterIds: ["area"],
        stopIds: points.map((p) => p.id),
        startId: points[0].id,
      };
      const preview = {
        draftId: input.draftId,
        clusterIds: input.clusterIds,
        stopIds: input.stopIds,
        startId: input.startId,
      };
      assert.equal(
        (
          await f.request("/api/citywalk/preview", {
            user: null,
            body: preview,
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await f.request("/api/citywalk/preview", {
            user: "other",
            body: preview,
          })
        ).status,
        410,
      );
      assert.equal(
        (
          await f.request("/api/citywalk/preview", {
            user: "user",
            body: { ...preview, stopIds: ["博物馆", "fake"] },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await f.request("/api/citywalk/preview", {
            user: "user",
            body: { ...preview, lat: 0 },
          })
        ).status,
        400,
      );
      assert.equal(
        (await ready("/api/citywalk/preview", preview)).data.route.distanceM,
        1200,
      );
      const next = "/api/citywalk/drafts/" + draft.draftId + "/nearby",
        nextBody = { clusterIds: ["area"], anchorId: "博物馆" };
      assert.equal(
        (await f.request(next, { user: "other", body: nextBody })).status,
        410,
      );
      assert.equal(
        (
          await f.request(next, {
            user: "user",
            body: { ...nextBody, anchorId: "fake" },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await f.request(next, {
            user: "user",
            body: { ...nextBody, clusterIds: ["area", "area"] },
          })
        ).status,
        400,
      );
      const parallel = await Promise.all(
        Array.from({ length: 20 }, () => ready(next, nextBody)),
      );
      assert.ok(parallel.every((r) => r.status === 200));
      assert.equal(nearbyCalls, 1);
      assert.equal(
        (
          await ready("/api/citywalk/preview", {
            ...preview,
            stopIds: ["博物馆", "near-博物馆"],
          })
        ).status,
        200,
      );
      for (const d of [9999, 10000, 10001, 14999, 15000, 15001]) {
        distance = d;
        const result = await f.request("/api/citywalks", {
          user: "user",
          body: { ...input, id: randomUUID() },
        });
        assert.equal(result.status, d >= 15000 ? 422 : 200, "distance " + d);
        if (d < 15000) {
          assert.equal(result.data.distance_m, d);
          assert.equal(result.data.verified_route.warning, d > 10000);
        }
      }
      unavailable = true;
      const before = (await f.query("SELECT count(*)::int n FROM citywalks"))
        .rows[0].n;
      assert.equal(
        (await f.request("/api/citywalks", { user: "user", body: input }))
          .status,
        503,
      );
      assert.equal(
        (await f.query("SELECT count(*)::int n FROM citywalks")).rows[0].n,
        before,
      );
      unavailable = false;
      distance = 1200;
      const replay = await Promise.all(
        Array.from({ length: 20 }, () =>
          f.request("/api/citywalks", { user: "user", body: input }),
        ),
      );
      assert.ok(replay.every((r) => r.status === 200));
      assert.equal(
        (
          await f.query("SELECT count(*)::int n FROM citywalks WHERE id=$1", [
            input.id,
          ])
        ).rows[0].n,
        1,
      );
      const edits = await Promise.all(
        Array.from({ length: 10 }, () =>
          f.request("/api/citywalks/" + input.id, {
            user: "user",
            method: "PUT",
            body: { ...input, version: 1 },
          }),
        ),
      );
      assert.equal(edits.filter((r) => r.status === 200).length, 1);
      assert.equal(edits.filter((r) => r.status === 409).length, 9);
      assert.equal(
        (await f.request("/api/citywalks/" + input.id, { user: "other" }))
          .status,
        404,
      );
      const times = [],
        start = performance.now();
      let errors = 0;
      for (let batch = 0; batch < 5; batch++)
        await Promise.all(
          Array.from({ length: 20 }, async () => {
            const t = performance.now(),
              r = await f.request("/api/citywalks", { user: "user" });
            times.push(performance.now() - t);
            if (r.status !== 200) errors++;
          }),
        );
      times.sort((a, b) => a - b);
      assert.equal(errors, 0);
      t.diagnostic(
        JSON.stringify({
          requests: 100,
          concurrency: 20,
          errors,
          p50: Math.round(times[50]),
          p95: Math.round(times[95]),
          elapsedMs: Math.round(performance.now() - start),
          paidCalls: 0,
        }),
      );
    } finally {
      await f.close();
    }
  },
);
