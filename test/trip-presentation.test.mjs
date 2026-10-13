import test from "node:test";
import assert from "node:assert/strict";
import {
  overviewPoints,
  recentPlans,
  amapLegUrl,
} from "../public/trip-view.js";
import { scenicMemberMarkup } from "../public/scenic-view.js";
import { createReadJobs } from "../server/services/read-jobs.mjs";
import { readCityPlaces } from "../server/services/city-clusters.mjs";

test("overview keeps origin and chosen city order without duplicating a same-city origin", () => {
  const a = { id: "sh", name: "上海", lng: 121.47, lat: 31.23 },
    b = { id: "bj", name: "北京", lng: 116.39, lat: 39.92 };
  const trip = {
    request: { origin: { ...a, label: "上海" } },
    plan: { cities: [a, b] },
  };
  assert.deepEqual(
    overviewPoints(trip).map((p) => p.name),
    ["上海", "北京"],
  );
  trip.request.origin = { label: "未知" };
  assert.equal(overviewPoints(trip).length, 2);
});
test("plans use save time rather than itinerary update time, and pagination preserves order", () => {
  const trips = Array.from({ length: 17 }, (_, i) => ({
    id: String(i),
    created_at: new Date(1000 * i).toISOString(),
    updated_at: new Date(100000 - i).toISOString(),
  }));
  const ordered = recentPlans(trips);
  assert.equal(ordered[0].id, "16");
  assert.equal(ordered.slice(0, 10).length, 10);
  assert.equal(ordered.slice(0, 15).at(-1).id, "2");
  assert.equal(trips[0].id, "0");
});
test("only outer scenic parent exposes a wish; actual nested names have inline disclosure", () => {
  const markup = scenicMemberMarkup({
    id: "palace",
    name: "故宫",
    children: [
      { id: "hall", name: "太和殿", parentId: "palace" },
      { id: "inner", name: "内部展厅", parentId: "hall" },
    ],
  });
  assert.equal((markup.match(/data-wanted=/g) || []).length, 1);
  assert.equal((markup.match(/class="disclosure"/g) || []).length, 2);
  assert.doesNotMatch(markup, /一起逛|建议|景区内/);
  assert.match(markup, /<summary><span>故宫<\/span><span class="disclosure"/);
});
test("navigation opens the selected leg; no fake whole-day waypoint support", () => {
  const a = { name: "故宫", lng: 116.39, lat: 39.92 },
    b = { name: "景山", lng: 116.39, lat: 39.93 };
  const url = new URL(amapLegUrl(a, b, "walk"));
  assert.match(url.searchParams.get("from"), /故宫$/);
  assert.match(url.searchParams.get("to"), /景山$/);
  assert.equal(url.searchParams.get("callnative"), "1");
  assert.equal(url.searchParams.get("mode"), "walk");
  assert.equal(new URL(amapLegUrl(null, a)).searchParams.get("from"), "");
  assert.equal(amapLegUrl(a, {}), null);
});
test("slow city jobs return immediately, coalesce polls, isolate users, recover after errors", async () => {
  let complete,
    calls = 0;
  const jobs = createReadJobs();
  const work = () => {
    calls++;
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  assert.equal(jobs("userA:session:bj", work).status, "loading");
  await Promise.resolve();
  assert.equal(jobs("userA:session:bj", work).status, "loading");
  assert.equal(calls, 1);
  complete({ city: "北京" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(jobs("userA:session:bj", work), { city: "北京" });
  assert.equal(
    jobs("userB:session:bj", () => Promise.reject(Error("offline"))).status,
    "loading",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => jobs("userB:session:bj", work), /offline/);
  assert.equal(jobs("userB:session:bj", work).status, "loading");
});
test("one transient OSM failure retries without losing city places; persistent errors do not become empty success", async () => {
  let calls = 0;
  const bounds = { west: 116, east: 117, south: 39, north: 40 };
  const result = await readCityPlaces(bounds, async () => {
    if (++calls === 1) throw Object.assign(Error("busy"), { status: 429 });
    return { status: "live", items: [{ id: "palace" }] };
  });
  assert.equal(calls, 2);
  assert.equal(result.items[0].id, "palace");
  await assert.rejects(
    readCityPlaces(bounds, async () => {
      throw Object.assign(Error("offline"), { status: 503 });
    }),
    /offline/,
  );
});
