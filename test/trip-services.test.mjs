/* 验证行程周边服务。 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import express from "express";
import {
  serviceSlots,
  rankServicePlaces,
} from "../server/domain/trip-services.mjs";
import { installTripServiceRoutes } from "../server/services/trip-services.mjs";
const stops = [
  {
    id: "a",
    name: "甲",
    lat: 31,
    lng: 121,
    leave: "12:00",
    country: "CN",
    mainlandCityVerified: true,
  },
  { id: "b", name: "乙", lat: 31.01, lng: 121, leave: "17:00" },
];
const plan = {
  schemaVersion: "journey/2",
  days: [
    { city: "上海", cityId: "sh", date: "2026-10-20", stops },
    { city: "上海", cityId: "sh", date: "2026-10-21", stops: [stops[1]] },
    { city: "杭州", cityId: "hz", date: "2026-10-22", stops },
    { city: "上海", cityId: "sh", date: "2026-10-23", stops },
  ],
};
test("eating anchors follow the itinerary; hotel choice is shared only across consecutive same-city days", () => {
  const a = serviceSlots(plan, 0),
    b = serviceSlots(plan, 1);
  assert.equal(a[0].anchor.id, "a");
  assert.equal(a[1].anchor.id, "b");
  assert.deepEqual(a[2].days, [0, 1]);
  assert.equal(a[2].scopeKey, b[2].scopeKey);
  assert.equal(serviceSlots(plan, 3)[2].id, "stay:3-3");
  assert.deepEqual(
    serviceSlots({ days: [{ stops: [{ id: "bad", lat: null, lng: 1 }] }] }, 0),
    [],
  );
  assert.throws(() => serviceSlots(plan, 9));
  const changed = structuredClone(plan);
  changed.services = {
    [a[0].id]: { scopeKey: a[0].scopeKey, candidate: { name: "餐厅" } },
  };
  changed.days[0].stops[0].lat += 0.1;
  assert.equal(serviceSlots(changed, 0)[0].selected.reviewNeeded, true);
});
test("ranking rejects wrong categories, missing coordinates and duplicates; known facts keep evidence, unknown prices stay empty", () => {
  const row = {
    id: "osm:node/1",
    name: "顺路餐厅",
    lat: 31.003,
    lng: 121,
    category: "food",
    source_url: "https://www.openstreetmap.org/node/1",
    facts: { phone: { value: "123" } },
  };
  const rows = [
    { ...row, id: "osm:node/2", lng: 121.01 },
    row,
    row,
    { ...row, id: "bar", subcategory: "bar" },
    { ...row, id: "cafe", subcategory: "cafe" },
    { ...row, id: "hotel", category: "accommodation" },
    { ...row, id: "bad", lat: null },
  ];
  const ranked = rankServicePlaces(
    rows,
    { status: "live" },
    serviceSlots(plan, 0)[0],
  );
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, row.id);
  assert.equal(ranked[0].facts.ticketPrice.value, null);
  assert.equal(ranked[0].facts.phone.value, "123");
  assert.equal(ranked[0].distanceKind, "straight_line");
  assert.equal(ranked[0].sources[0].provider, "OpenStreetMap");
});
test(
  "PostgreSQL nearby services: cache, ownership, preview, atomic saves, shared stay, removal and stale pools",
  { skip: process.env.TEST_TRIP_SERVICES !== "1" },
  async () => {
    const config = JSON.parse(
      await readFile(
        new URL("../.runtime/local.json", import.meta.url),
        "utf8",
      ),
    );
    const settings = {
      host: "127.0.0.1",
      port: config.port,
      user: "seatraces",
      password: config.password,
      database: "seatraces",
    };
    const admin = new pg.Client(settings),
      schema = "services_test_" + randomBytes(6).toString("hex");
    let pool, server;
    const a = randomUUID(),
      b = randomUUID(),
      id = randomUUID(),
      other = randomUUID();
    let priceCalls = 0;
    let calls = 0,
      fail = false;
    try {
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({
        ...settings,
        max: 4,
        options: "-c search_path=" + schema,
      });
      const query = (sql, args) => pool.query(sql, args);
      const transaction = async (fn) => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const r = await fn(c);
          await c.query("COMMIT");
          return r;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      };
      await query(
        "CREATE TABLE trips(id uuid PRIMARY KEY,user_id uuid,plan jsonb,version integer DEFAULT 1,updated_at timestamptz DEFAULT now()); CREATE TABLE trip_versions(trip_id uuid,version integer,plan jsonb,reason text,PRIMARY KEY(trip_id,version))",
      );
      await query(
        await readFile(
          new URL("../server/trip-services-schema.sql", import.meta.url),
          "utf8",
        ),
      );
      await query(
        await readFile(
          new URL("../server/service-prices-schema.sql", import.meta.url),
          "utf8",
        ),
      );
      await query(
        "INSERT INTO trips(id,user_id,plan) VALUES($1,$2,$3),($4,$5,$3)",
        [id, a, JSON.stringify(plan), other, b],
      );
      const app = express();
      app.use(express.json());
      const auth = (req, res, next) => {
        if (![a, b].includes(req.headers["x-test-owner"]))
          return res.sendStatus(401);
        req.user = { id: req.headers["x-test-owner"] };
        next();
      };
      installTripServiceRoutes(app, {
        auth,
        query,
        transaction,
        priceSearch: async () => {
          priceCalls++;
          return { pois: [] };
        },
        search: async (path, q) => {
          calls++;
          if (fail) throw Error("offline");
          return {
            status: "live",
            items: [
              {
                id: "osm:node/" + (q.category === "food" ? "1" : "2"),
                name: q.category === "food" ? "测试餐厅" : "测试住宿",
                category: q.category,
                lat: q.lat,
                lng: q.lng,
              },
            ],
          };
        },
      });
      app.use((e, req, res, next) =>
        res
          .status(e.status || (e.name === "ZodError" ? 400 : 500))
          .json({ error: e.message }),
      );
      server = app.listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      const base =
        "http://127.0.0.1:" + server.address().port + "/api/journey/trips/";
      const req = async (
        path = "",
        body,
        method = body ? "POST" : "GET",
        owner = a,
        trip = id,
      ) => {
        const r = await fetch(base + trip + "/services" + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            "x-test-owner": owner,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return {
          status: r.status,
          data: r.headers.get("content-type")?.includes("json")
            ? await r.json()
            : null,
        };
      };
      assert.equal((await req("", null, "GET", "")).status, 401);
      assert.equal((await req("", null, "GET", b)).status, 404);
      const first = await req("/recommendations", { day: 0 });
      assert.equal(first.status, 200);
      assert.equal(calls, 3);
      const again = await req("/recommendations", { day: 0 });
      assert.equal(calls, 3);
      assert.equal(again.data.slots[0].cached, true);
      const lunch = first.data.slots[0],
        hotel = first.data.slots[2];
      const selection = {
        version: 1,
        recommendationId: lunch.recommendationId,
        placeId: lunch.items[0].id,
      };
      assert.equal((await req("/lunch:0/preview", selection)).status, 200);
      assert.equal(
        (await req("/lunch:0", { ...selection, placeId: "invented" }, "PUT"))
          .status,
        409,
      );
      assert.equal(
        (await req("/lunch:0", selection, "PUT", b, other)).status,
        409,
      );
      const concurrent = await Promise.all([
        req("/lunch:0", selection, "PUT"),
        req("/lunch:0", selection, "PUT"),
      ]);
      assert.deepEqual(concurrent.map((x) => x.status).sort(), [200, 409]);
      assert.equal(
        (await req()).data.days[0].slots[0].selected.candidate.name,
        "测试餐厅",
      );
      const saved = await req(
        "/stay:0-1",
        {
          version: 2,
          recommendationId: hotel.recommendationId,
          placeId: hotel.items[0].id,
        },
        "PUT",
      );
      assert.equal(saved.status, 200);
      assert.equal(
        (await req()).data.days[1].slots[2].selected.candidate.name,
        "测试住宿",
      );
      assert.equal(
        (await req("/lunch:0", { version: 3 }, "DELETE")).status,
        200,
      );
      assert.equal((await req()).data.days[0].slots[0].selected, null);
      assert.equal(
        Number((await query("SELECT count(*) n FROM trip_versions")).rows[0].n),
        3,
      );
      const unified = await req("/recommendations", {
        day: 0,
        groupMeals: true,
        activeSlot: "dining:0",
      });
      assert.equal(unified.status, 200);
      assert.deepEqual(
        unified.data.slots.map((s) => s.kind),
        ["dining", "stay"],
      );
      assert.equal(unified.data.slots[0].sort, "distance");
      assert.equal(priceCalls, 0);
      const refreshed = await req("/recommendations", {
        day: 0,
        groupMeals: true,
        activeSlot: "dining:0",
        refresh: true,
        sort: "price",
      });
      assert.equal(refreshed.status, 200);
      assert.equal(refreshed.data.slots[0].sort, "distance");
      assert.equal(priceCalls, 0, "loading and refreshing never request prices");
      const stored = await query("SELECT * FROM place_service_prices");
      assert.equal(stored.rows.length, 0);
      await query(
        "UPDATE trip_service_recommendations SET expires_at=now()-interval '1 second'",
      );
      assert.equal(
        (await req("/lunch:0", { ...selection, version: 4 }, "PUT")).status,
        409,
      );
      fail = true;
      const unavailable = await req("/recommendations", { day: 0 });
      assert.equal(unavailable.status, 200);
      assert.equal(unavailable.data.slots[0].status, "unavailable");
      assert.equal(
        (await req()).data.days[1].slots[2].selected.candidate.name,
        "测试住宿",
      );
      assert.equal(
        (await req("/recommendations", { day: 0, radius: 10001 })).status,
        400,
      );
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
      if (pool) await pool.end();
      await admin
        .query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
        .catch(() => {});
      await admin.end();
    }
  },
);
