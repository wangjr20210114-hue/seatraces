import test from "node:test";
import assert from "node:assert/strict";
import { createApiReservation } from "../server/repositories/api-usage.mjs";
import { currentPosition, locationMessage } from "../public/geolocation.js";
import {
  selectedPools,
  enrichCandidate,
} from "../server/services/journey-service.mjs";
import { deduplicateVisitPlaces } from "../server/domain/scenic-clusters.mjs";

test("nearby Palace Museum aliases are one visit; gates, other museums and remote campuses stay distinct", () => {
  const a = { id: "a", name: "故宫", lat: 39.91727565, lng: 116.3907694 };
  const input = [
    a,
    { ...a, id: "b", name: "故宫博物院", lat: 39.9174311 },
    { ...a, id: "c", name: "故宫博物院北院区", lat: 40.0963 },
    { ...a, id: "d", name: "午门" },
    { ...a, id: "e", name: "其他博物馆" },
    { ...a, id: "f", name: "故宫", lat: 41 },
  ];
  const r = deduplicateVisitPlaces(input);
  assert.equal(r.length, 5);
  assert.deepEqual(r[0].possibleDuplicateIds, ["b"]);
  assert.ok(r[0].aliases.includes("故宫博物院"));
  assert.equal(a.aliases, undefined);
});

function reservation({ total = 100, own = 10, used = 10, env = {} } = {}) {
  let inserts = 0;
  return {
    count: () => inserts,
    call: createApiReservation({
      env: { API_LOCAL_LIMITS_ENABLED: "true", ...env },
      transact: async (fn) =>
        fn({
          query: async (sql) => {
            if (sql.includes("sum(reserved_cny)"))
              return { rows: [{ n: used }] };
            if (sql.includes("count(*)"))
              return { rows: [{ n: total, provider_n: own }] };
            if (sql.startsWith("INSERT")) inserts++;
            return { rows: [] };
          },
        }),
    }),
  };
}
test("opt-in local caps keep separate provider allowances and enforce daily/monthly ceilings", async () => {
  const r = reservation();
  await r.call("DeepSeek");
  assert.equal(r.count(), 1);
  await assert.rejects(
    reservation({ own: 50 }).call("DeepSeek"),
    (e) => e.code === "local_daily_limit",
  );
  await assert.rejects(
    reservation({ used: 199.95 }).call("DeepSeek"),
    (e) => e.code === "local_monthly_budget",
  );
  await assert.rejects(
    reservation({ env: { API_DAILY_REQUEST_LIMIT: "100" } }).call("DeepSeek"),
    (e) => e.code === "local_daily_limit",
  );
});
test("native geolocation returns actual device coordinates and explains permission/signal failures", async () => {
  assert.deepEqual(
    await currentPosition({
      native: {
        requestLocation: async () =>
          JSON.stringify({ ok: true, lat: 31.2, lng: 121.4 }),
      },
    }),
    { lat: 31.2, lng: 121.4 },
  );
  await assert.rejects(
    currentPosition({
      native: {
        requestLocation: async () =>
          JSON.stringify({ ok: false, code: "timeout" }),
      },
    }),
    /GPS/,
  );
  await assert.rejects(
    currentPosition({
      native: {
        requestLocation: async () =>
          JSON.stringify({ ok: true, lat: 999, lng: 121 }),
      },
    }),
    /无效/,
  );
  assert.match(locationMessage("permission", true), /权限/);
  assert.match(locationMessage("disabled", true), /服务未开启/);
});
test("a coarse area can supply the full bounded 60-POI planning pool", () => {
  const members = Array.from({ length: 300 }, (_, i) => ({ id: String(i) }));
  assert.equal(
    selectedPools({ a: { clusters: [{ id: "x", members }] } }, { a: ["x"] }, [
      { id: "a" },
    ]).a.length,
    60,
  );
});
test("fresh place details retain derived aliases for provider matching and merged visit records", () => {
  const p = {
    id: "a",
    name: "故宫",
    aliases: ["故宫博物院"],
    possibleDuplicateIds: ["b"],
    city: "北京",
    country: "CN",
  };
  const result = enrichCandidate(
    p,
    { id: "a", aliases: ["紫禁城"], facts: { website: { value: "official" } } },
    { b: { source: "user_confirmed" } },
    {},
  );
  assert.deepEqual(result.aliases, ["故宫博物院", "紫禁城"]);
  assert.equal(result.visited, true);
  assert.equal(result.facts.website.value, "official");
});
