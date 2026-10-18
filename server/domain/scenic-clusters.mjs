import { createHash } from "node:crypto";
import { groupScenicEntities, representedIds } from "./scenic-entities.mjs";
export { deduplicateVisitPlaces } from "./scenic-entities.mjs";
export const clusterRules = {
  version: "city-areas/3",
  minClusters: 1,
  maxClusters: 12,
};
export function visitable(p) {
  const t = p.traits || {};
  if (/^\d+号?门$|^(入口|出口|售票处|售票厅|游客中心)$/u.test(p.name || ""))
    return false;
  if (
    !p.name?.trim() ||
    !Number.isFinite(p.lat) ||
    !Number.isFinite(p.lng) ||
    ["no", "private"].includes(p.access)
  )
    return false;
  if (p.category === "attraction")
    return (
      !["information", "artwork"].includes(t.tourism) ||
      Boolean(t.wikipedia || t.wikidata)
    );
  if (p.category === "heritage")
    return (
      ![
        "boundary_stone",
        "milestone",
        "wayside_cross",
        "wayside_shrine",
        "memorial",
      ].includes(t.historic) || Boolean(t.wikipedia || t.heritage)
    );
  if (p.category === "nature")
    return (
      [
        "peak",
        "beach",
        "cave_entrance",
        "volcano",
        "hot_spring",
        "waterfall",
      ].includes(t.natural) || p.subcategory === "waterfall"
    );
  return (
    p.category === "leisure" &&
    ["park", "garden", "nature_reserve", "water_park"].includes(t.leisure)
  );
}
export function placeTags(p) {
  const t = p.traits || {},
    s = JSON.stringify(t);
  return [
    ...new Set([
      ...(["heritage"].includes(p.category) ? ["人文", "建筑"] : []),
      ...(/museum|gallery/.test(s) ? ["人文", "艺术"] : []),
      ...(/garden/.test(s) ? ["园林", "自然"] : []),
      ...(/park|nature|beach|peak|waterfall/.test(s) ? ["自然"] : []),
      ...(/zoo|theme_park/.test(s) ? ["亲子"] : []),
    ]),
  ];
}
function knownSignal(s, now) {
  return (
    s &&
    Number.isFinite(s.value) &&
    s.value >= 0 &&
    s.value <= 1 &&
    s.sourceUrl &&
    Date.parse(s.expiresAt) > now
  );
}
export function scorePlace(
  p,
  preferences = {},
  signals = {},
  now = Date.now(),
) {
  const t = p.traits || {},
    tags = placeTags(p),
    observed = {
      fame: knownSignal(signals.fame, now),
      crowd: knownSignal(signals.crowd, now),
    };
  const parts = {
    base: p.hierarchyOnly ? 0 : 20,
    fame: observed.fame ? 30 * signals.fame.value : 0,
    documentationProxy: observed.fame
      ? 0
      : (t.wikipedia ? 8 : 0) + (t.wikidata ? 4 : 0) + (t.heritage ? 10 : 0),
    information: Math.min(
      8,
      [p.opening_hours, t.website].filter(Boolean).length * 4,
    ),
    preference:
      tags.filter((t) => (preferences.interests || []).includes(t)).length * 5,
    inferredPreference: Math.max(-4, Math.min(4, tags.reduce((n,t)=>n+(Number.isFinite(preferences.styleWeights?.[t])?preferences.styleWeights[t]*4:0),0))),
    novelty: p.visited ? (preferences.revisit === "new" ? -12 : 0) : 0,
    crowd: observed.crowd
      ? -({ avoid: 25, balanced: 12, lively: 3 }[preferences.crowd] ?? 12) *
        signals.crowd.value
      : 0,
  };
  return {
    total:
      Math.round(
        Math.max(
          0,
          Object.values(parts).reduce((a, b) => a + b, 0),
        ) * 10,
      ) / 10,
    parts,
    personalInterest: Math.round((parts.preference + parts.inferredPreference) * 100) / 100,
    coverage: {
      fame: observed.fame ? "sourced" : "missing",
      crowd: observed.crowd ? "sourced" : "missing",
    },
    tags,
  };
}
export function clusterScenicPlaces(input, preferences = {}, signalsById = {}) {
  const unique = new Map();
  for (const p of input.filter(visitable))
    if (!unique.has(p.id))
      unique.set(p.id, {
        ...p,
        score: scorePlace(p, preferences, signalsById[p.id]),
      });
  const points = [...unique.values()].sort(
    (a, b) => b.score.total - a.score.total || a.id.localeCompare(b.id),
  );
  // Group duplicate OSM representations only when their labels and positions agree.
  const dedup = groupScenicEntities(points);
  for (const p of dedup) {
    p.score = scorePlace(p, preferences, signalsById[p.id]);
    p.children = (p.children || [])
      .map((c) => ({
        ...c,
        score: scorePlace(c, preferences, signalsById[c.id]),
      }))
      .sort(
        (a, b) => b.score.total - a.score.total || a.id.localeCompare(b.id),
      );
    // Distinct child sights contribute once; duplicate records add no extra score.
    const childrenScore = (p.children || []).reduce(
      (n, c) => n + c.score.total,
      0,
    );
    p.score = {
      ...p.score,
      total: Math.round((p.score.total + childrenScore) * 10) / 10,
      // A large number of children must not drown out the visitor's interest.
      // A relevant child can help its containing site, but contributes once.
      personalInterest: Math.round((p.score.personalInterest + .25 * Math.max(0, ...p.children.map(c => c.score.personalInterest))) * 100) / 100,
      childrenScore,
    };
  }
  if (!dedup.length) return [];
  // Geographic bisecting k-means. Membership depends on position, not popularity.
  // These are city selection areas; daily itineraries still select nearby stops.
  const target = Math.min(
    dedup.length,
    clusterRules.maxClusters,
    Math.max(1, Math.ceil(Math.sqrt(dedup.length / 15))),
  );
  const cos = Math.cos(
    ((dedup.reduce((n, p) => n + p.lat, 0) / dedup.length) * Math.PI) / 180,
  );
  const xy = (p) => [p.lng * cos * 111.32, p.lat * 111.32];
  const mean = (ps) =>
    ps.reduce(
      (a, p) => {
        const q = xy(p);
        return [a[0] + q[0] / ps.length, a[1] + q[1] / ps.length];
      },
      [0, 0],
    );
  const squared = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const spread = (ps) => {
    const m = mean(ps);
    return ps.reduce((n, p) => n + squared(xy(p), m), 0);
  };
  const split = (ps) => {
    const center = mean(ps);
    const farthest = (q) =>
      ps.reduce(
        (a, p) => (squared(xy(p), q) > squared(xy(a), q) ? p : a),
        ps[0],
      );
    let a = xy(farthest(center)),
      b = xy(farthest(a)),
      left = [],
      right = [];
    for (let pass = 0; pass < 30; pass++) {
      left = [];
      right = [];
      for (const p of ps)
        (squared(xy(p), a) <= squared(xy(p), b) ? left : right).push(p);
      if (!left.length || !right.length)
        return [
          ps.slice(0, Math.ceil(ps.length / 2)),
          ps.slice(Math.ceil(ps.length / 2)),
        ];
      const na = mean(left),
        nb = mean(right),
        shift = squared(a, na) + squared(b, nb);
      a = na;
      b = nb;
      if (shift < 0.000001) break;
    }
    return [left, right];
  };
  const partitions = [dedup.slice().sort((a, b) => a.id.localeCompare(b.id))];
  while (partitions.length < target) {
    const choices = partitions
      .map((ps, index) => ({ index, score: ps.length > 1 ? spread(ps) : -1 }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const chosen = choices[0];
    // Co-located sights should not create artificial selection areas.
    if (chosen.score <= 0.000001) break;
    partitions.splice(chosen.index, 1, ...split(partitions[chosen.index]));
  }
  const groups = [];
  for (const partition of partitions) {
    const group = partition.sort(
      (a, b) => b.score.personalInterest - a.score.personalInterest || b.score.total - a.score.total || a.id.localeCompare(b.id),
    );
    const id =
      "cluster-" +
      createHash("sha256")
        .update(
          group
            .map((p) => p.id)
            .sort()
            .join("|"),
        )
        .digest("hex")
        .slice(0, 14);
    const districtCounts = {};
    for (const p of group)
      if (p.district)
        districtCounts[p.district] = (districtCounts[p.district] || 0) + 1;
    const districts = Object.keys(districtCounts).sort(
      (a, b) => districtCounts[b] - districtCounts[a],
    );
    groups.push({
      id,
      name: group[0].name + "一带",
      districts,
      center: {
        lat: group.reduce((s, p) => s + p.lat, 0) / group.length,
        lng: group.reduce((s, p) => s + p.lng, 0) / group.length,
      },
      anchor: {
        id: group[0].id,
        name: group[0].name,
        lat: group[0].lat,
        lng: group[0].lng,
        crs: "WGS84",
      },
      selectionScope: "city_area",
      score: Math.round(group.reduce((s, p) => s + p.score.total, 0) * 10) / 10,
      memberCount: group.length,
      sourceRecordCount: new Set(group.flatMap(representedIds)).size,
      childCount: group.reduce((n, p) => n + (p.children?.length || 0), 0),
      scoreCoverage: {
        fame: group.filter((p) => p.score.coverage.fame === "sourced").length,
        crowd: group.filter((p) => p.score.coverage.crowd === "sourced").length,
      },
      members: group,
      ruleVersion: clusterRules.version,
    });
  }
  return groups
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((g, i) => ({ ...g, number: i + 1 }));
}
