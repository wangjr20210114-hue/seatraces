/* 验证候选地点检索与转换。 */

import test from "node:test";
import assert from "node:assert/strict";
import { createCandidateService } from "../server/services/place-candidates.mjs";
import { toGcj } from "../public/coordinates.js";

test("provider first result without a qualifying similarity is not silently substituted", async () => {
  const search = createCandidateService({
    localSearch: async () => ({ status: "live", items: [] }),
    amapSearch: async () => ({
      pois: [
        poi("C1", "孔氏南宗家庙"),
        poi("C2", "另一景点"),
        poi("C3", "孔庙酒店", { type: "住宿服务" }),
      ],
    }),
    env: { AMAP_KEY: "TEST" },
  });
  const data = await search({ ...input, q: "孔庙" });
  assert.equal(data.status, "empty");
  assert.equal(data.items.length, 0);
  assert.equal(data.fallback.requests, 1);
});

const point = { lat: 31.324, lng: 120.624 };
const input = { q: "样本园", countryCode: "CN", ...point };
const osm = (id = "osm:node/1", name = "样本园") => ({
  id,
  name,
  ...point,
  aliases: [],
  category: "attraction",
  subcategory: "garden",
  country: null,
  source_timestamp: "2026-10-09T00:00:00Z",
  source_url: "https://www.openstreetmap.org/node/1",
  facts: { fee: { value: "90", status: "source_reported" } },
});
const poi = (id, name, extra = {}) => ({
  id,
  name,
  location: toGcj(point),
  type: "风景名胜;公园广场",
  business: { cost: "90" },
  ...extra,
});
const now = "2026-10-11T09:00:00.000Z";

test("semantic ranking sees only geographically eligible scenic candidates and does not confirm identity", async () => {
  let names;
  const search = createCandidateService({
    localSearch: async () => ({ status: "live", items: [] }),
    amapSearch: async () => ({
      pois: [
        poi("B", "孔庙站", { type: "交通设施服务" }),
        poi("F", "曲阜孔庙", { location: toGcj({ lat: 35.59, lng: 116.98 }) }),
        poi("K", "孔氏南宗家庙"),
      ],
    }),
    rankSemantic: async (q, items) => {
      names = items.map((p) => p.name);
      return {
        status: "ready",
        items: items.map((p, rank) => ({
          ...p,
          semantic: { cosine: 0.817, rank },
        })),
      };
    },
    env: { AMAP_KEY: "TEST", EMBEDDING_ENABLED: "true" },
  });
  const r = await search({ ...input, q: "衢州孔庙" });
  assert.deepEqual(names, ["孔氏南宗家庙"]);
  assert.equal(r.status, "ready");
  assert.equal(r.items[0].match.semanticSimilarity, 0.817);
  assert.equal(r.items[0].match.requiresNameConfirmation, false);
  assert.equal(r.items.length, 1);
  assert.equal(r.selection.resolvedName, "孔氏南宗家庙");
});

test("embedding unavailable retains exact-name candidate and bounded fallback", async () => {
  const search = createCandidateService({
    localSearch: async () => ({ status: "live", items: [osm()] }),
    rankSemantic: async (q, items) => ({
      items,
      status: "unavailable_fallback",
    }),
    env: { EMBEDDING_ENABLED: "true" },
  });
  const r = await search(input);
  assert.equal(r.status, "ready");
  assert.equal(r.fallback.requests, 0);
});

test("a usable local candidate avoids paid calls and never turns fee into ticket price", async () => {
  let calls = 0;
  const search = createCandidateService({
    localSearch: async () => ({ status: "live", items: [osm()] }),
    amapSearch: async () => {
      calls++;
      throw Error("unexpected");
    },
    env: { AMAP_KEY: "TEST" },
    clock: () => now,
  });
  const data = await search(input);
  assert.equal(data.status, "ready");
  assert.equal(calls, 0);
  assert.equal(data.items[0].facts.ticketPrice.value, null);
  assert.equal(data.items[0].facts.fee.value, "90");
  assert.equal(data.items[0].facts.fee.sourceUpdatedAt, null);
  assert.equal(data.items[0].location.city, null);
  assert.ok(data.items[0].quality.missingForTravel.includes("ticketPrice"));
});

test("one fallback page filters shops and out-of-area results, keeping source-only facts", async () => {
  let calls = 0;
  const search = createCandidateService({
    localSearch: async () => ({ status: "live", items: [] }),
    amapSearch: async () => {
      calls++;
      return {
        pois: [
          poi("P1", "样本园"),
          poi("P2", "样本园购物店", { type: "购物服务" }),
          poi("P3", "样本园", { location: toGcj({ lat: 39.9, lng: 116.4 }) }),
        ],
      };
    },
    env: { AMAP_KEY: "TEST" },
    clock: () => now,
  });
  const data = await search(input);
  assert.equal(calls, 1);
  assert.equal(data.status, "ready");
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].sources[0].persistence, "request_only");
  assert.equal(data.items[0].location.point.crs, "WGS84");
  assert.equal(data.items[0].routingHint.crs, "GCJ02");
  assert.equal(data.items[0].facts.ticketPrice.value, null);
});

test("insufficient discovery, budget refusal and overseas scope do not fabricate or retry", async () => {
  let calls = 0;
  const search = createCandidateService({
    localSearch: async () => ({ status: "live", items: [osm()] }),
    amapSearch: async () => {
      calls++;
      throw Object.assign(Error("budget"), { status: 429 });
    },
    env: { AMAP_KEY: "TEST" },
  });
  const partial = await search({
    ...input,
    intent: "discover",
    q: "",
    minCandidates: 5,
  });
  assert.equal(partial.status, "partial");
  assert.equal(partial.items.length, 1);
  assert.equal(partial.fallback.status, "budget_or_rate_limited");
  assert.equal(calls, 1);
  const overseas = await search({
    ...input,
    countryCode: "JP",
    lat: 35.6,
    lng: 139.7,
  });
  assert.equal(overseas.fallback.status, "unsupported_region");
  assert.equal(calls, 1);
  await assert.rejects(search({ ...input, minCandidates: 10, limit: 2 }));
  assert.equal(calls, 1);
});

test("snapshot age and possible duplicate grouping remain explicit", async () => {
  const cachedAt = "2026-10-10T00:00:00.000Z";
  const search = createCandidateService({
    localSearch: async () => ({
      status: "snapshot",
      cachedAt,
      items: [osm(), osm("osm:way/2")],
    }),
    env: {},
    clock: () => now,
  });
  const data = await search(input);
  assert.equal(data.items.length, 1);
  assert.deepEqual(data.items[0].possibleDuplicateIds, ["osm:way/2"]);
  assert.equal(data.items[0].sources[0].retrievedAt, cachedAt);
  assert.equal(data.items[0].delivery.status, "snapshot");
});
