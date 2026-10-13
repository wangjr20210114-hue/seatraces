import test from "node:test";
import assert from "node:assert/strict";
import { createCandidateService } from "../server/services/place-candidates.mjs";
import { createCatalogService } from "../server/services/catalog.mjs";
import { createNearbyRecommendations } from "../server/services/nearby-recommendations.mjs";
import { officialOpening } from "../server/official-opening.mjs";
import { makePlan, schedule } from "../server/planner.mjs";
import { knownFact, factValue } from "../public/place-information.js";
const point = { lat: 28.95, lng: 118.87 };
const row = (id, name, category = "heritage") => ({
  id,
  name,
  category,
  ...point,
  aliases: [],
  facts: {},
  country: "CN",
});
test("named search recalls local neighbours and returns only the best eligible semantic substitute", async () => {
  let paid = 0,
    queries = [];
  const search = createCandidateService({
    env: { EMBEDDING_ENABLED: "true", AMAP_KEY: "TEST" },
    localSearch: async (path, q) => {
      queries.push(q);
      return {
        status: "live",
        items: q.q
          ? []
          : [
              row("osm:way/1", "孔氏南宗家庙"),
              row("osm:way/2", "衢州书院"),
              row("osm:way/3", "孔庙站", "transport"),
            ],
      };
    },
    rankSemantic: async (q, items) => ({
      status: "ready",
      items: items.map((p) => ({
        ...p,
        semantic: { cosine: p.name === "孔氏南宗家庙" ? 0.82 : 0.67 },
      })),
    }),
    amapSearch: async () => {
      paid++;
      return { pois: [] };
    },
  });
  const r = await search({
    ...point,
    q: "衢州孔庙",
    countryCode: "CN",
    intent: "named",
  });
  assert.equal(queries.length, 2);
  assert.equal(queries[1].q, "");
  assert.equal(paid, 0);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].name, "孔氏南宗家庙");
  assert.equal(r.selection.originalQuery, "衢州孔庙");
  assert.equal(r.selection.identityVerified, false);
});
test("weak semantic matches do not become a replacement merely by ranking first", async () => {
  const search = createCandidateService({
    env: { EMBEDDING_ENABLED: "true" },
    localSearch: async () => ({
      status: "live",
      items: [row("osm:way/1", "完全无关")],
    }),
    rankSemantic: async (q, items) => ({
      status: "ready",
      items: items.map((p) => ({ ...p, semantic: { cosine: 0.2 } })),
    }),
  });
  assert.equal(
    (
      await search({
        ...point,
        q: "衢州孔庙",
        countryCode: "CN",
        fallback: "never",
      })
    ).items.length,
    0,
  );
});
test("legacy hasMore is stripped from both live and cached responses; timeout is distinct", async () => {
  const env = { OSM_SERVICE_URL: "http://test" },
    saved = { items: [], hasMore: true };
  const live = createCatalogService({
    env,
    requestSource: async () => saved,
    remember: () => {},
  });
  assert.equal("hasMore" in (await live.catalogRequest("/places")), false);
  const offline = createCatalogService({
    env,
    requestSource: async () => {
      throw Error();
    },
    cached: () => ({ payload: saved, at: "2026-01-01" }),
  });
  assert.equal("hasMore" in (await offline.catalogRequest("/places")), false);
  const timeout = createCatalogService({
    env,
    requestSource: async () => {
      throw Object.assign(Error(), {
        status: 504,
        code: "catalog_query_timeout",
      });
    },
    cached: () => null,
  });
  await assert.rejects(
    timeout.catalogRequest("/places"),
    (e) => e.status === 504 && e.code === "catalog_query_timeout",
  );
});
const official = (value, extra = {}) => ({
  value,
  status: "evidence_reviewed",
  source: "官方测试来源",
  sourceUrl: "https://example.com/official",
  sourceTimestamp: "2026-01-01",
  evidence: { reviewStatus: "accepted", reviewAfter: "2099-01-01T00:00:00Z" },
  ...extra,
});
test("official winter hours outrank OSM summer hours, with unresolved holiday exceptions retained", () => {
  const p = {
    opening_hours: "07:30-17:30",
    facts: {
      openingHours: official(
        "3-10月 07:30-17:30；11-次年2月 07:30-17:00；清明、五一、中秋、十一期间延迟半小时闭园，18:00闭园",
      ),
    },
  };
  const r = officialOpening(p, "2026-11-12");
  assert.equal(r.regularIntervals[0].end, "17:00");
  assert.equal(r.source, "官方测试来源");
  assert.equal(r.canConstrainSchedule, false);
  assert.equal(r.dayState, "uncertain");
  assert.equal(r.intervals.length, 0);
  p.facts.openingHours = official("随季节变化，另行公告");
  assert.equal(officialOpening(p, "2026-11-12").status, "unparseable");
  p.facts.openingHours = official("3-10月07:30-17:30", {
    evidence: { reviewStatus: "accepted", reviewAfter: "2020-01-01T00:00:00Z" },
  });
  assert.equal(officialOpening(p, "2026-11-12").status, "needs_review");
});
test("nearby food and lodging remain usable with missing optional facts and never become stops", async () => {
  const nearby = createNearbyRecommendations(async (path, q) => ({
    status: "live",
    items: [
      {
        ...row("osm:node/" + q.category, q.category, q.category),
        distance_m: 123,
      },
    ],
  }));
  const r = await nearby(point);
  assert.equal(r.automaticItineraryStops, false);
  for (const g of Object.values(r.groups)) {
    assert.equal(g.items[0].quality.searchUsable, true);
    assert.deepEqual(g.items[0].quality.missingForTravel, []);
  }
  const places = [
    "attraction",
    "heritage",
    "nature",
    "leisure",
    "hotel",
    "food",
  ].map((c) => ({ ...row(c, c, c), city: "衢州", tags: [], duration_min: 30 }));
  const plan = makePlan(
    { start: "2026-10-12", end: "2026-10-12", pace: "full", interests: [] },
    [{ name: "衢州" }],
    places,
  );
  assert.equal(plan.days[0].anchor, null);
  assert.equal(plan.days[0].stops.length, 4);
  assert.ok(
    plan.days[0].stops.every((p) => p.timingStatus === "opening_unconfirmed"),
  );
  assert.equal(schedule([places[4], places[5]], "2026-10-12").stops.length, 0);
});
test("missing or expired facts render no placeholder while zero remains meaningful", () => {
  assert.equal(factValue("ticketPrice", null), "");
  assert.equal(knownFact({ value: 0, status: "source_reported" }), true);
  assert.equal(knownFact({ value: "old", status: "needs_review" }), false);
  assert.equal(
    knownFact(official("old", { evidence: { reviewAfter: "2020-01-01" } })),
    false,
  );
});
