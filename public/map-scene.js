import { toGcj, mainlandEligible } from "./coordinates.js";
import { hasPosition } from "./trip-view.js";

// Stored places are WGS84; provider boundaries are already GCJ02.
// Keep conversion at this boundary, never in the map renderer.
export function scenePoint(place, context = {}) {
  if (!hasPosition(place)) return null;
  const p = {
    ...context,
    ...place,
    country: place.country || place.location?.countryCode || context.country,
    lat: Number(place.lat),
    lng: Number(place.lng),
  };
  return {
    id: p.id,
    name: p.name || p.label || "",
    position:
      p.crs === "GCJ02" || !mainlandEligible(p)
        ? [p.lng, p.lat]
        : toGcj(p).split(",").map(Number),
  };
}

export function plannerScene({
  city,
  boundary,
  clusters = [],
  selected = [],
  district = "",
  fitKey,
  contextKey,
}) {
  const groups = clusters.filter(
    (g) => !district || g.districts?.includes(district),
  );
  return {
    type: "seatraces-overview",
    kind: "planner",
    lockView: true,
    view: "day",
    segments: [],
    contextKey,
    fitKey,
    viewPadding: [80, 48, 35, 35],
    focus: scenePoint(city)?.position,
    boundary,
    district,
    clusters: groups
      .map((g, i) => {
        const point = scenePoint(g.anchor || g.center, city);
        return (
          point && {
            ...point,
            id: g.id,
            name: g.name,
            number: g.number || i + 1,
            selected: selected.includes(g.id),
          }
        );
      })
      .filter(Boolean),
    wishes: groups
      .flatMap((g) =>
        g.members.filter((p) => p.ownWanted).map((p) => scenePoint(p, city)),
      )
      .filter(Boolean),
  };
}

export function serviceScene(base, slot, selectedId) {
  const saved = slot.selected?.candidate;
  const candidates = [...slot.items];
  if (saved && !candidates.some((p) => p.id === saved.id))
    candidates.push(saved);
  const services = candidates
    .map((p) => {
      const point = scenePoint(p, base.cityContext);
      return (
        point && {
          ...point,
          kind: slot.kind,
          selected: p.id === selectedId,
          saved: p.id === saved?.id,
        }
      );
    })
    .filter(Boolean);
  return {
    ...base,
    kind: "services",
    view: "day",
    lockView: true,
    contextKey: `services:${base.tripId}:${base.day}:${slot.id}:${slot.radius}`,
    fitKey: `services:${base.tripId}:${base.day}:${slot.id}:${slot.radius}:${slot.items
      .map((p) => p.id)
      .sort()
      .join(",")}`,
    viewPadding: [90, 55, 40, 40],
    services,
    serviceAnchor: scenePoint(
      candidates.find((p) => p.id === selectedId)?.nearestAnchor || slot.anchor,
      base.cityContext,
    ),
  };
}

export function savedServicePoints(trip, day) {
  const seen = new Set();
  const city =
    trip?.plan?.cities?.find((c) => c.id === trip.plan.days[day]?.cityId) || {};
  return Object.values(trip?.plan?.services || {})
    .filter((s) => s.days?.includes(day))
    .map((s) => {
      const p = scenePoint(s.candidate, city);
      if (!p || seen.has(p.id)) return null;
      seen.add(p.id);
      return { ...p, kind: s.kind, saved: true, slotId: s.slotId };
    })
    .filter(Boolean);
}
