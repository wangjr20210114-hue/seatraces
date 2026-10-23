/* 验证周边服务地图链接。 */

import test from "node:test";
import assert from "node:assert/strict";
import { servicePlaceUrl } from "../public/service-place-link.js";
test("AMap place view preserves coordinate system, names and invalid-point handling", () => {
  const p = { name: "餐厅 & 酒店", lng: 116.4, lat: 39.9 };
  const link = new URL(servicePlaceUrl(p));
  assert.equal(link.origin, "https://uri.amap.com");
  assert.equal(link.pathname, "/marker");
  assert.equal(link.searchParams.get("position"), "116.4,39.9");
  assert.equal(link.searchParams.get("coordinate"), "wgs84");
  assert.equal(link.searchParams.get("name"), p.name);
  assert.equal(
    new URL(servicePlaceUrl({ ...p, crs: "GCJ02" })).searchParams.get(
      "coordinate",
    ),
    "gaode",
  );
  assert.equal(servicePlaceUrl({ ...p, lat: null }), null);
  assert.equal(servicePlaceUrl({ ...p, lng: 300 }), null);
});
