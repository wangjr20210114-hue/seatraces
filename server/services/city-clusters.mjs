import { catalogRequest } from "./catalog.mjs";
import {
  cityBoundaries,
  cityBoundingBox,
  inCity,
  districtOf,
  publicBoundary,
} from "./city-boundaries.mjs";
import { clusterScenicPlaces } from "../domain/scenic-clusters.mjs";
import { clusterInventory, applyWishes } from "../domain/scenic-entities.mjs";
import {
  currentParentHierarchy,
  queueParentChecks,
} from "./scenic-parents.mjs";
const cache = new Map(),
  flights = new Map();
export async function readCityPlaces(bounds, request = catalogRequest) {
  const pending = [bounds],
    points = new Map();
  let queries = 0,
    snapshotAt = null,
    status = "live",
    incomplete = false;
  while (pending.length) {
    const box = pending.pop();
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await request("/cluster-places", box);
        break;
      } catch (e) {
        // Retry only transient reads on our own OSM service; never paid APIs.
        if (attempt >= 1 || ![429, 503, 504].includes(e.status)) throw e;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
    queries++;
    if (!["live", "snapshot"].includes(r.status))
      throw Object.assign(Error("城市景点暂未连接，请重试"), { status: 503 });
    if (r.status === "snapshot") {
      status = "snapshot";
      snapshotAt = r.cachedAt || snapshotAt;
    }
    if (r.coverageStatus === "bounded_sample") {
      const w = box.east - box.west,
        h = box.north - box.south;
      // Split any truncated box instead of pretending its first 8,000 rows are
      // the full city. Only an extremely dense sub-100 m box remains flagged.
      if (Math.max(w, h) > 0.0005) {
        if (w >= h) {
          const mid = (box.east + box.west) / 2;
          pending.push({ ...box, east: mid }, { ...box, west: mid });
        } else {
          const mid = (box.north + box.south) / 2;
          pending.push({ ...box, north: mid }, { ...box, south: mid });
        }
        continue;
      }
      incomplete = true;
    }
    for (const p of r.items || []) points.set(p.id, p);
  }
  return {
    items: [...points.values()],
    status,
    cachedAt: snapshotAt,
    queries,
    coverageStatus: incomplete ? "bounded_sample" : "within_requested_bbox",
  };
}
export async function cityCatalog(city) {
  let base = cache.get(city.id);
  if (!base || base.expires < Date.now()) {
    if (!flights.has(city.id))
      flights.set(
        city.id,
        (async () => {
          const boundary = await cityBoundaries(city),
            bounds = cityBoundingBox(city, boundary);
          const r = await readCityPlaces(bounds);
          if (!["live", "snapshot"].includes(r.status))
            throw Object.assign(Error("城市景点暂未连接，请重试"), {
              status: 503,
            });
          const places = r.items
            .filter((p) => inCity(p, boundary))
            .map((p) => ({
              ...p,
              city: city.name,
              country: city.country,
              timezone: city.timezone,
              mainlandCityVerified:
                city.country === "CN" && boundary.cityRings.length > 0,
              district: districtOf(p, boundary),
              source_url: "https://www.openstreetmap.org/" + p.id.slice(4),
            }));
          const value = {
            places,
            boundary: publicBoundary(boundary),
            coverage: {
              source: r.status,
              scope: boundary.cityRings.length
                ? "city_boundary"
                : "city_surroundings",
              status: r.coverageStatus,
              snapshotAt: r.cachedAt || null,
              catalogQueries: r.queries,
            },
            expires: Date.now() + 15 * 60_000,
          };
          cache.set(city.id, value);
          if (cache.size > 12) cache.delete(cache.keys().next().value);
          return value;
        })().finally(() => flights.delete(city.id)),
      );
    try {
      base = await flights.get(city.id);
    } catch (e) {
      if (!base || Date.now() - base.expires > 24 * 3600_000) throw e;
      return {
        ...base,
        coverage: {
          ...base.coverage,
          source: "snapshot",
          snapshotAt: new Date(base.expires - 15 * 60_000).toISOString(),
        },
      };
    }
  }
  // District polygons may have arrived after the first city response.
  const boundary = await cityBoundaries(city);
  return {
    ...base,
    boundary: publicBoundary(boundary),
    places: base.places.map((p) => ({
      ...p,
      district: districtOf(p, boundary),
    })),
  };
}
export async function clusterCity(
  city,
  preferences,
  visits = {},
  signals = {},
  wishes = {},
) {
  const base = await cityCatalog(city);
  const hierarchy = await currentParentHierarchy(base.places);
  const parentJob = queueParentChecks(city, base.places);
  const clusters = clusterScenicPlaces(
    hierarchy.places.map((p) => ({
      ...p,
      visited: Boolean(visits[p.id]),
      visitHistory: visits[p.id] || null,
    })),
    preferences,
    signals,
  ).map((g) => ({
    ...g,
    members: g.members.map((p) => applyWishes(p, wishes)),
  }));
  return {
    city,
    clusters,
    boundary: base.boundary,
    coverage: base.coverage,
    inventory: clusterInventory(clusters),
    parentLookup: { ...hierarchy.coverage, job: { ...parentJob } },
    scoreVersion: "scenic-score/1",
    attribution: "© OpenStreetMap contributors · 高德地图",
  };
}
