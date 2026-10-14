import { amap } from "../integrations/amap.mjs";
import { toGcj, toWgs } from "../../public/coordinates.js";
import { distance } from "../planner.mjs";
const cache = new Map(),
  flights = new Map();
const norm = (s) => s.replace(/[市县区]$/, "");
export function ringsOf(value) {
  return String(value || "")
    .split("|")
    .map((r) =>
      r
        .split(";")
        .map((s) => s.split(",").map(Number))
        .filter((p) => p.length === 2 && p.every(Number.isFinite)),
    )
    .filter((r) => r.length >= 3);
}
export function ringBounds(rings) {
  const out = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of rings)
    for (const [x, y] of ring) {
      out[0] = Math.min(out[0], x);
      out[1] = Math.min(out[1], y);
      out[2] = Math.max(out[2], x);
      out[3] = Math.max(out[3], y);
    }
  return out;
}
export function contains(point, rings) {
  for (const ring of rings) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i],
        [xj, yj] = ring[j];
      if (
        yi > point[1] !== yj > point[1] &&
        point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
      )
        inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}
export function simplify(ring, tolerance = 0.00018) {
  if (ring.length < 6) return ring;
  const kept = new Set([0, ring.length - 1]),
    stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = tolerance * tolerance,
      k = -1;
    const p = ring[a],
      q = ring[b],
      dx = q[0] - p[0],
      dy = q[1] - p[1];
    for (let i = a + 1; i < b; i++) {
      const x = ring[i],
        t =
          dx || dy
            ? Math.max(
                0,
                Math.min(
                  1,
                  ((x[0] - p[0]) * dx + (x[1] - p[1]) * dy) /
                    (dx * dx + dy * dy),
                ),
              )
            : 0;
      const d = (x[0] - p[0] - t * dx) ** 2 + (x[1] - p[1] - t * dy) ** 2;
      if (d > max) {
        max = d;
        k = i;
      }
    }
    if (k >= 0) {
      kept.add(k);
      stack.push([a, k], [k, b]);
    }
  }
  return [...kept].sort((a, b) => a - b).map((i) => ring[i]);
}
export async function cityBoundaries(city) {
  if (city.country !== "CN")
    return {
      status: "unsupported",
      cityRings: [],
      districts: [],
      provider: null,
    };
  const saved = cache.get(city.id);
  if (saved?.expires > Date.now()) return saved.value;
  if (flights.has(city.id)) return flights.get(city.id);
  const work = (async () => {
    const data = await amap("v3/config/district", {
      keywords: city.name,
      subdistrict: 2,
      extensions: "all",
    });
    const candidates = (data.districts || []).filter(
      (d) =>
        ["city", "province"].includes(d.level) &&
        norm(d.name) === norm(city.name),
    );
    candidates.sort((a, b) => {
      const conv = (d) => {
        const p = toWgs(d.center)[0];
        return p ? distance(city, { lat: p[0], lng: p[1] }) : Infinity;
      };
      return conv(a) - conv(b);
    });
    const chosen = candidates[0];
    if (!chosen)
      throw Object.assign(Error("暂时没有找到这个城市的边界"), { status: 422 });
    const cityRings = ringsOf(chosen.polyline);
    if (!cityRings.length)
      throw Object.assign(Error("城市边界暂不可用"), { status: 502 });
    const children = [],
      walk = (d) => {
        if (d.level === "district") children.push(d);
        else for (const x of d.districts || []) walk(x);
      };
    for (const c of chosen.districts || []) walk(c);
    const wanted = [
        ...new Map(children.map((d) => [d.adcode, d])).values(),
      ].slice(0, 45),
      districts = [];
    const value = {
      status: wanted.length ? "loading" : "live",
      provider: "高德地图",
      adcode: chosen.adcode,
      cityRings,
      districts,
      failedDistricts: 0,
      checkedAt: new Date().toISOString(),
      crs: "GCJ02",
      persistence: "session_only",
    };
    cache.set(city.id, { value, expires: Date.now() + 6 * 3600_000 });
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    // The city outline is sufficient to fetch candidates. District enrichment
    // continues off the critical path and reuses the provider's paced queue.
    void (async () => {
      let failed = 0;
      const failures = [];
      for (let i = 0; i < wanted.length; i += 1) {
        const results = await Promise.allSettled(
          wanted.slice(i, i + 1).map(async (d) => {
            const r = await amap("v3/config/district", {
                keywords: d.adcode,
                subdistrict: 0,
                extensions: "all",
              }),
              v = r.districts?.find((x) => x.adcode === d.adcode),
              rings = ringsOf(v?.polyline);
            if (!rings.length) throw Error("no boundary");
            return {
              name: d.name,
              adcode: d.adcode,
              rings,
              center: d.center.split(",").map(Number),
            };
          }),
        );
        for (const r of results) {
          if (r.status === "fulfilled") districts.push(r.value);
          else {
            failed++;
            failures.push({
              adcode: wanted[i].adcode,
              code: r.reason.providerCode || "unavailable",
            });
          }
        }
      }
      Object.assign(value, {
        status: failed ? "partial" : "live",
        failedDistricts: failed,
        failures,
      });
    })().catch(() => {
      value.status = "partial";
    });
    return value;
  })().finally(() => flights.delete(city.id));
  flights.set(city.id, work);
  return work;
}
export function cityBoundingBox(city, boundary) {
  if (!boundary.cityRings.length)
    return {
      west: city.lng - 0.45,
      south: city.lat - 0.4,
      east: city.lng + 0.45,
      north: city.lat + 0.4,
    };
  const [w, s, e, n] = ringBounds(boundary.cityRings);
  const a = toWgs(`${w},${s};${e},${n}`);
  return {
    west: a[0][1] - 0.01,
    south: a[0][0] - 0.01,
    east: a[1][1] + 0.01,
    north: a[1][0] + 0.01,
  };
}
export function inCity(p, boundary) {
  return (
    !boundary.cityRings.length ||
    contains(toGcj(p).split(",").map(Number), boundary.cityRings)
  );
}
export function districtOf(p, boundary) {
  const point = toGcj(p).split(",").map(Number);
  return (
    boundary.districts.find((d) => {
      const [w, s, e, n] = d.bounds || (d.bounds = ringBounds(d.rings));
      return (
        point[0] >= w &&
        point[0] <= e &&
        point[1] >= s &&
        point[1] <= n &&
        contains(point, d.rings)
      );
    })?.name || null
  );
}
export function publicBoundary(boundary) {
  return {
    ...boundary,
    cityRings: boundary.cityRings.map((r) => simplify(r)),
    districts: boundary.districts.map((d) => ({
      ...d,
      rings: d.rings.map((r) => simplify(r)),
    })),
  };
}
