/* 整理行程概览、地图站点和导航入口。 */

import { toGcj } from "./coordinates.js";

export const hasPosition = (p) =>
  p &&
  p.lat !== null &&
  p.lng !== null &&
  Number.isFinite(Number(p.lat)) &&
  Number.isFinite(Number(p.lng)) &&
  Math.abs(Number(p.lat)) <= 90 &&
  Math.abs(Number(p.lng)) <= 180;
export function mapPoint(p, id = p.id) {
  return {
    id,
    name: p.name || p.label,
    position: toGcj(p).split(",").map(Number),
  };
}
export function overviewPoints(trip) {
  const origin = trip?.request?.origin;
  const points = [
    ...(hasPosition(origin) ? [mapPoint(origin, "origin")] : []),
    ...(trip?.plan?.cities || []).filter(hasPosition).map((p) => mapPoint(p)),
  ];
  return points.filter((p, i) => {
    if (!i) return true;
    const prior = points[i - 1],
      gap =
        Math.abs(p.position[0] - prior.position[0]) +
        Math.abs(p.position[1] - prior.position[1]);
    return (
      gap > 0.0001 &&
      !(
        p.name?.replace(/市$/, "") === prior.name?.replace(/市$/, "") &&
        gap < 0.25
      )
    );
  });
}
export function recentPlans(trips) {
  return [...trips].sort(
    (a, b) =>
      (Date.parse(b.created_at || b.plan?.generatedAt) || 0) -
        (Date.parse(a.created_at || a.plan?.generatedAt) || 0) ||
      String(b.id).localeCompare(String(a.id)),
  );
}
export function amapLegUrl(from, to, transport = "balanced") {
  if (!hasPosition(to)) return null;
  const endpoint = (p) =>
    toGcj(p) + "," + String(p.name || p.label || "").replaceAll(",", " ");
  const params = new URLSearchParams({
    from: hasPosition(from) ? endpoint(from) : "",
    to: endpoint(to),
    mode: transport === "walk" ? "walk" : transport === "drive" ? "car" : "bus",
    policy:
      transport === "fewTransfers"
        ? "1"
        : transport === "fewWalking"
          ? "2"
          : "0",
    src: "SeaTraces",
    callnative: "1",
  });
  return "https://uri.amap.com/navigation?" + params;
}
