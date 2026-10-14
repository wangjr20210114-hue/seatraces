import test from "node:test";
import assert from "node:assert/strict";
import { matchServicePrice } from "../server/domain/service-pricing.mjs";
import {
  selectServiceBatch,
  serviceSlots,
  metres,
} from "../server/domain/trip-services.mjs";
import {
  serviceComparator,
  servicePriceText,
} from "../public/service-order.js";
import { toGcj } from "../public/coordinates.js";
const p = {
  id: "osm:node/1",
  name: "四季餐厅",
  lat: 39.91,
  lng: 116.39,
  classification: { category: "food" },
  distanceMeters: 100,
  facts: {},
};
const poi = {
  id: "B001",
  name: p.name,
  typecode: "050100",
  location: toGcj(p),
  business: { cost: "68" },
};
test("prices require strong local identity, category and an unambiguous merchant; no inferred values", () => {
  assert.equal(matchServicePrice(p, [poi]).amount, 68);
  assert.equal(
    matchServicePrice(p, [{ ...poi, name: p.name + "(故宫店)" }]).amount,
    68,
  );
  assert.equal(
    matchServicePrice({ ...p, name: p.name + "(北京店)" }, [
      { ...poi, name: p.name + "(上海店)" },
    ]).amount,
    null,
  );
  assert.equal(
    matchServicePrice(p, [{ ...poi, business: { cost: [] } }]).amount,
    null,
  );
  assert.equal(
    matchServicePrice(p, [{ ...poi, business: { cost: "0" } }]).amount,
    null,
  );
  assert.equal(
    matchServicePrice(p, [{ ...poi, business: { cost: "68元起" } }]).amount,
    null,
  );
  assert.equal(
    matchServicePrice(p, [{ ...poi, typecode: "100100" }]).status,
    "unmatched",
  );
  assert.equal(
    matchServicePrice(p, [{ ...poi, location: "121,31" }]).status,
    "unmatched",
  );
  assert.equal(
    matchServicePrice(p, [poi, { ...poi, id: "B002" }]).status,
    "unmatched",
  );
  assert.equal(
    matchServicePrice(p, [
      { ...poi, business: undefined, biz_ext: { cost: "88" } },
    ]).amount,
    88,
  );
  assert.equal(
    servicePriceText({ price: { status: "unavailable", amount: null } }),
    "人均 暂无",
  );
});
test("five dispersed merchants, distinct batches, graceful sparse fallback and price ordering", () => {
  const pool = Array.from({ length: 12 }, (_, i) => ({
    ...p,
    id: "p" + i,
    name: "餐厅" + i,
    lat: p.lat + i * 0.004,
    distanceMeters: 100 + i * 200,
  }));
  const first = selectServiceBatch(pool);
  assert.equal(first.items.length, 5);
  for (let i = 1; i < 5; i++)
    assert.ok(metres(first.items[i], first.items[i - 1]) >= 300);
  const second = selectServiceBatch(pool, {
    refresh: true,
    excludePlaceIds: first.items.map((p) => p.id),
  });
  assert.equal(second.items.length, 5);
  assert.ok(second.items.every((p) => !first.items.some((q) => q.id === p.id)));
  assert.equal(selectServiceBatch([p, p]).items.length, 1);
  assert.equal(selectServiceBatch([p, p]).canRefresh, false);
  const sorted = [
    { ...p, id: "unknown" },
    { ...p, id: "expensive", price: { status: "available", amount: 150 } },
    { ...p, id: "cheap", price: { status: "available", amount: 50 } },
  ].sort(serviceComparator("price"));
  assert.deepEqual(
    sorted.map((p) => p.id),
    ["cheap", "expensive", "unknown"],
  );
});
test("unified dining covers daily stops and preserves older meal selections", () => {
  const plan = {
    days: [{ city: "北京", stops: [p, { ...p, id: "two", lat: 39.95 }] }],
    services: { "lunch:0": { slotId: "lunch:0", candidate: p } },
  };
  const unified = serviceSlots(plan, 0, { groupMeals: true });
  assert.deepEqual(
    unified.map((s) => s.kind),
    ["dining", "stay"],
  );
  assert.equal(unified[0].anchors.length, 2);
  assert.equal(unified[0].previousSelections[0].slotId, "lunch:0");
  assert.deepEqual(
    serviceSlots(plan, 0).map((s) => s.kind),
    ["lunch", "dinner", "stay"],
  );
});
