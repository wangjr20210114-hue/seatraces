import { createHash } from "node:crypto";
import {
  metres,
  orderWalk,
  walkName,
  routeMetres,
} from "../../public/citywalk-route.js";
export const walkCategories = new Set([
  "attraction",
  "heritage",
  "nature",
  "leisure",
  "food",
  "shopping",
]);
export function validWalkPlace(p) {
  return Boolean(
    p?.id &&
      p.name?.trim() &&
      walkCategories.has(p.category) &&
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lng) &&
      Math.abs(p.lat) <= 90 &&
      Math.abs(p.lng) <= 180 &&
      !["private", "no"].includes(p.access),
  );
}
// Only collapse exact same-category names within 40 m in this recommendation
// view. Source records and genuinely distinct branches remain untouched.
export function uniqueWalkPlaces(input) {
  const ids = new Set(),
    names = new Map(),
    out = [];
  for (const p of input) {
    if (!validWalkPlace(p) || ids.has(p.id)) continue;
    ids.add(p.id);
    const key =
      p.category +
      ":" +
      walkName(p).normalize("NFKC").replace(/\s/g, "").toLowerCase();
    const same = names.get(key) || [];
    if (same.some((q) => metres(p, q) <= 40)) continue;
    same.push(p);
    names.set(key, same);
    out.push(p);
  }
  return out;
}
// A bounded-radius connected cluster, not city-scale k-means. The spatial grid
// keeps isolated points from bridging distant districts into a single walk.
export function clusterWalkPlaces(
  input,
  { linkMetres = 500, radiusMetres = 850, maxMembers = 60 } = {},
) {
  const points = uniqueWalkPlaces(input).map((p) => ({
    ...p,
    name: walkName(p),
  }));
  if (!points.length) return [];
  const cos = Math.max(0.1, Math.cos((points[0].lat * Math.PI) / 180)),
    grid = new Map(),
    cell = (p) => [
      Math.floor((p.lng * 111320 * cos) / linkMetres),
      Math.floor((p.lat * 111320) / linkMetres),
    ];
  for (const p of points) {
    const k = cell(p).join(",");
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }
  const importance = (p) =>
    ({
      attraction: 5,
      heritage: 4,
      nature: 3,
      leisure: 3,
      shopping: 2,
      food: 1,
    })[p.category] || 0;
  points.sort(
    (a, b) => importance(b) - importance(a) || a.id.localeCompare(b.id),
  );
  const used = new Set(),
    groups = [];
  for (const seed of points) {
    if (used.has(seed.id)) continue;
    const members = [seed],
      found = new Set([seed.id]);
    for (
      let pos = 0;
      pos < members.length && members.length < maxMembers;
      pos++
    ) {
      const current = members[pos],
        [x, y] = cell(current),
        neighbors = [];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const p of grid.get([x + dx, y + dy].join(",")) || [])
            if (
              !used.has(p.id) &&
              !found.has(p.id) &&
              metres(seed, p) <= radiusMetres &&
              metres(current, p) <= linkMetres
            )
              neighbors.push(p);
      neighbors.sort(
        (a, b) =>
          metres(current, a) - metres(current, b) || a.id.localeCompare(b.id),
      );
      for (const p of neighbors) {
        if (members.length >= maxMembers) break;
        found.add(p.id);
        members.push(p);
      }
    }
    if (members.length < 2) continue;
    for (const p of members) used.add(p.id);
    const suggested = orderWalk(members.slice(0, 6), seed.id),
      id =
        "walk-area-" +
        createHash("sha256")
          .update(
            members
              .map((p) => p.id)
              .sort()
              .join("|"),
          )
          .digest("hex")
          .slice(0, 14);
    groups.push({
      id,
      name: seed.name + "附近",
      center: { lat: seed.lat, lng: seed.lng },
      anchor: seed,
      members,
      memberCount: members.length,
      suggestedStopIds: suggested.map((p) => p.id),
      estimatedDistanceM: Math.round(routeMetres(suggested)),
      selectionScope: "walk_neighborhood",
      score: members.reduce((s, p) => s + importance(p), 0),
      ruleVersion: "walk-cluster/1",
    });
  }
  return groups
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((g, i) => ({ ...g, number: i + 1 }));
}
