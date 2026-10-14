import { serviceComparator } from "../../public/service-order.js";
export { serviceComparator };
import { createHash } from "node:crypto";
import { fromOsm } from "./place-candidate.mjs";
const point = (p) =>
  p &&
  p.lat != null &&
  p.lng != null &&
  Number.isFinite(Number(p.lat)) &&
  Number.isFinite(Number(p.lng)) &&
  Math.abs(p.lat) <= 90 &&
  Math.abs(p.lng) <= 180;
export function metres(a, b) {
  const rad = Math.PI / 180,
    lat = (b.lat - a.lat) * rad,
    lng = (b.lng - a.lng) * rad;
  return (
    6371000 *
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin(lat / 2) ** 2 +
            Math.cos(a.lat * rad) *
              Math.cos(b.lat * rad) *
              Math.sin(lng / 2) ** 2,
        ),
      ),
    )
  );
}
const minutes = (s) =>
  /^\d{2}:\d{2}$/.test(s || "")
    ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
    : null;
const compact = (p) => ({
  id: p.id,
  name: p.name,
  lat: Number(p.lat),
  lng: Number(p.lng),
  country: p.country,
  mainlandCityVerified: p.mainlandCityVerified,
});
const cityKey = (d) => d.cityId || d.city;
export function serviceSlots(plan, dayIndex, { groupMeals = false } = {}) {
  const days = plan.days || [],
    day = days[dayIndex];
  if (!day) throw Object.assign(Error("旅行日期不存在"), { status: 400 });
  const stops = (day.stops || []).filter(point);
  if (!stops.length) return [];
  let lunchIndex = stops.findIndex((p) => minutes(p.leave) >= 690);
  if (lunchIndex < 0) lunchIndex = Math.floor((stops.length - 1) / 2);
  let first = dayIndex,
    last = dayIndex;
  while (first > 0 && cityKey(days[first - 1]) === cityKey(day)) first--;
  while (last + 1 < days.length && cityKey(days[last + 1]) === cityKey(day))
    last++;
  const area = days
    .slice(first, last + 1)
    .flatMap((d) => (d.stops || []).filter(point));
  // Use a real stop nearest all the block's sights, rather than a centroid in water.
  const anchors = area.filter(
    (p, i) => area.findIndex((x) => x.id === p.id) === i,
  );
  const centre = anchors.reduce((best, p) => {
    const score = area.reduce((sum, q) => sum + metres(p, q), 0);
    return !best || score < best.score ? { p, score } : best;
  }, null).p;
  let slots = [
    {
      id: "lunch:" + dayIndex,
      kind: "lunch",
      title: "午餐",
      anchor: compact(stops[lunchIndex]),
      next: stops[lunchIndex + 1] ? compact(stops[lunchIndex + 1]) : null,
      days: [dayIndex],
      radius: 1500,
    },
    {
      id: "dinner:" + dayIndex,
      kind: "dinner",
      title: "晚餐",
      anchor: compact(stops.at(-1)),
      next: null,
      days: [dayIndex],
      radius: 1500,
    },
    {
      id: "stay:" + first + "-" + last,
      kind: "stay",
      title: "住宿",
      anchor: compact(centre),
      next: null,
      days: Array.from({ length: last - first + 1 }, (_, i) => first + i),
      radius: 3000,
    },
  ];
  if (groupMeals)
    slots = [
      {
        id: "dining:" + dayIndex,
        kind: "dining",
        title: "餐饮",
        anchor: compact(stops[Math.floor((stops.length - 1) / 2)]),
        anchors: stops.map(compact),
        next: null,
        days: [dayIndex],
        radius: 1500,
        previousSelections: ["lunch:", "dinner:"]
          .map((k) => plan.services?.[k + dayIndex])
          .filter(Boolean),
      },
      slots[2],
    ];
  const city = plan.cities?.find((c) => c.id === day.cityId) || {};
  return slots.map((slot) => {
    slot.anchor = {
      ...slot.anchor,
      country: slot.anchor.country || city.country,
      mainlandCityVerified:
        slot.anchor.mainlandCityVerified || city.mainlandCityVerified,
    };
    const context = slot.days.map((i) => ({
      date: days[i].date,
      city: cityKey(days[i]),
      stops: (days[i].stops || []).filter(point).map(compact),
    }));
    const scopeKey = createHash("sha256")
      .update(
        JSON.stringify({
          kind: slot.kind,
          anchor: slot.anchor,
          next: slot.next,
          context,
        }),
      )
      .digest("hex");
    const selected = plan.services?.[slot.id];
    return {
      ...slot,
      city: day.city,
      date: day.date,
      fromDate: days[first].date,
      toDate: days[last].date,
      scopeKey,
      selected: selected
        ? { ...selected, reviewNeeded: selected.scopeKey !== scopeKey }
        : null,
    };
  });
}
export function rankServicePlaces(
  rows,
  delivery,
  slot,
  now = new Date().toISOString(),
) {
  const result = [],
    seen = new Set();
  for (const row of rows) {
    if (!point(row) || !String(row.name || "").trim() || seen.has(row.id))
      continue;
    const category = slot.kind === "stay" ? "accommodation" : "food";
    if (row.category !== category) continue;
    if (
      category === "food" &&
      ["cafe", "bar", "pub", "ice_cream"].includes(row.subcategory)
    )
      continue;
    seen.add(row.id);
    const candidate = fromOsm(
      { ...row, lat: Number(row.lat), lng: Number(row.lng) },
      delivery,
      category,
      now,
    );
    if (!candidate.quality.searchUsable) continue;
    const nearest = (slot.anchors || [slot.anchor]).reduce(
      (best, p) => (!best || metres(p, row) < metres(best, row) ? p : best),
      null,
    );
    const direct = metres(nearest, row);
    const detour = slot.next
      ? Math.max(
          0,
          direct + metres(row, slot.next) - metres(slot.anchor, slot.next),
        )
      : direct;
    result.push({
      ...candidate,
      lat: Number(row.lat),
      lng: Number(row.lng),
      country: row.country,
      mainlandCityVerified:
        row.mainlandCityVerified || slot.anchor.mainlandCityVerified,
      nearestAnchor: compact(nearest),
      distanceMeters: Math.round(direct),
      extraStraightLineMeters: Math.round(detour),
      distanceKind: "straight_line",
      rankCost: Math.round(
        slot.kind === "lunch" ? detour * 0.7 + direct * 0.3 : direct,
      ),
      reason:
        slot.kind === "stay"
          ? "靠近这几天游玩的区域"
          : slot.kind === "dining"
            ? "靠近当天行程"
            : slot.kind === "lunch"
              ? "靠近午间行程"
              : "靠近当天终点",
    });
  }
  return result.sort(
    (a, b) => a.rankCost - b.rankCost || a.id.localeCompare(b.id),
  );
}

export function selectServiceBatch(
  pool,
  {
    sort = "comprehensive",
    refresh = false,
    excludePlaceIds = [],
    kind = "dining",
    radius = 1500,
    random = Math.random,
  } = {},
) {
  const compare = serviceComparator(sort),
    excluded = new Set(excludePlaceIds);
  const unique = pool.filter(
    (p, i) =>
      pool.findIndex(
        (q) =>
          q.id === p.id ||
          (q.name.normalize("NFKC").replace(/\s/g, "") ===
            p.name.normalize("NFKC").replace(/\s/g, "") &&
            metres(p, q) < 80),
      ) === i,
  );
  const ordered = refresh
    ? unique
        .map((p) => ({ p, r: random() }))
        .sort((a, b) => a.r - b.r)
        .map((x) => x.p)
    : [...unique].sort(compare);
  const chosen = [],
    separation = Math.min(kind === "stay" ? 500 : 300, radius / 3);
  for (const seen of [false, true]) {
    for (const gap of [separation, separation / 2, 0]) {
      for (const p of ordered) {
        if (chosen.length === 5) break;
        if (excluded.has(p.id) !== seen || chosen.some((q) => q.id === p.id))
          continue;
        if (chosen.every((q) => metres(p, q) >= gap)) chosen.push(p);
      }
    }
  }
  return {
    items: chosen.sort(compare),
    canRefresh: unique.length > chosen.length,
    candidateCount: unique.length,
  };
}
export function serviceSearchAnchors(slot) {
  const candidates = slot.anchors || [slot.anchor],
    selected = [slot.anchor];
  while (selected.length < 4) {
    const best = candidates
      .filter((p) => !selected.some((q) => q.id === p.id))
      .map((p) => ({ p, d: Math.min(...selected.map((q) => metres(p, q))) }))
      .sort((a, b) => b.d - a.d)[0];
    if (!best || best.d < slot.radius) break;
    selected.push(best.p);
  }
  return selected;
}
