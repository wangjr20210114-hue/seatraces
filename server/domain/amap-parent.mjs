import { createHash } from "node:crypto";
import { distance } from "../planner.mjs";
import { toWgs } from "../../public/coordinates.js";
import { nameSimilarity } from "./place-matching.mjs";

export const parentInputHash = (p) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "amap-parent/1",
        p.name,
        p.lat,
        p.lng,
        p.country,
        p.extract_region,
      ]),
    )
    .digest("hex");
const norm = (s) =>
  String(s || "")
    .normalize("NFKC")
    .replace(/[\s\p{P}]/gu, "")
    .toLowerCase();
const short = (s) =>
  norm(s).replace(/(.{2,})(博物院|博物馆|风景名胜区|风景区|景区)$/u, "$1");
export function poiPoint(p) {
  if (!/^\d+(?:\.\d+)?,\d+(?:\.\d+)?$/.test(p.location || "")) return null;
  const [lat, lng] = toWgs(p.location)[0] || [];
  return Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= 18 &&
    lat <= 54 &&
    lng >= 73 &&
    lng <= 136
    ? { lat, lng }
    : null;
}
export function readParent(poi) {
  const value = poi.parent;
  if (value === "" || value === null || (Array.isArray(value) && !value.length))
    return { state: "none", id: null };
  if (typeof value === "string" && /^[A-Za-z0-9]{5,40}$/.test(value))
    return { state: "present", id: value };
  return { state: "unknown", id: null };
}
export function selectParentPoi(place, pois) {
  const labels = [
    place.name,
    ...(place.aliases || []),
    ...(place.editorialAliases || []),
  ].filter((x) => typeof x === "string" && norm(x).length >= 2);
  const ranked = [...new Map(pois.map((p) => [p.id, p])).values()]
    .flatMap((poi) => {
      const point = poiPoint(poi);
      if (
        !point ||
        !/^[A-Za-z0-9]{5,40}$/.test(poi.id || "") ||
        typeof poi.name !== "string"
      )
        return [];
      const meters = distance(place, point) * 1000;
      const suffix = poi.name.split(/[·・：:—－-]/u).at(-1);
      const nameScore = Math.max(
        0,
        ...labels.map((label) =>
          Math.max(
            nameSimilarity(label, poi.name),
            norm(label) === norm(suffix) ? 1 : 0,
            short(label) === short(poi.name) ? 1 : 0,
          ),
        ),
      );
      if (nameScore < 0.85 || meters > 1000) return [];
      return [
        {
          poi,
          nameScore,
          meters,
          score: 0.8 * nameScore + 0.2 * Math.exp(-meters / 500),
        },
      ];
    })
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return { status: "unmatched" };
  if (ranked[1] && ranked[0].score - ranked[1].score < 0.04)
    return { status: "ambiguous" };
  return { status: "matched", ...ranked[0] };
}

// Group before geographic partitioning so a parent and its children cannot end
// up in different city clusters. Pending checks remain visible and unconfirmed.
export function overlayParentChecks(points, checks) {
  const all = new Map(points.map((p) => [p.id, { ...p }]));
  const counts = {
    total: points.length,
    checked: 0,
    roots: 0,
    children: 0,
    pending: 0,
    unresolved: 0,
    unsupported: 0,
  };
  for (const p of points) {
    // The user's geometric hierarchy is the active product rule. Historic
    // provider checks remain stored but must not replace this build's parent.
    if (p.geometricHierarchy?.buildId) {
      counts.checked++;
      if (p.parentId) counts.children++;
      else if (p.geometricHierarchy.status === 'geometry_unavailable') counts.unresolved++;
      else counts.roots++;
      continue;
    }
    const check = checks.get(p.id),
      value = all.get(p.id);
    const status = check?.status || "pending";
    value.parentLookup = {
      status,
      provider: "amap",
      checkedAt: check?.checkedAt || null,
      poiId: check?.poiId || null,
    };
    if (status === "unsupported") {
      counts.unsupported++;
      continue;
    }
    if (status === "pending") {
      counts.pending++;
      continue;
    }
    if (!["root", "child"].includes(status)) {
      counts.unresolved++;
      continue;
    }
    counts.checked++;
    // Provider empty parent is an explicit display rule, not proof of real-world independence.
    value.parentId = status === "child" ? check.parentId : null;
    value.hierarchyLevel = status === "child" ? 2 : 1;
    value.parentRelation = {
      status: "provider_reported",
      provider: "amap",
      poiId: check.poiId,
      parentPoiId: check.parentPoiId || null,
      checkedAt: check.checkedAt,
    };
    if (status === "root") counts.roots++;
    else {
      counts.children++;
      for (const ancestor of check.ancestors || []) {
        if (!all.has(ancestor.id))
          all.set(ancestor.id, {
            ...ancestor,
            parentLookup: {
              status: "root",
              provider: "amap",
              checkedAt: check.checkedAt,
            },
            hierarchyLevel: 1,
          });
      }
    }
  }
  return {
    places: [...all.values()],
    coverage: {
      ...counts,
      status: counts.pending
        ? "pending"
        : counts.unresolved
          ? "partial"
          : "complete",
      ruleVersion: "amap-parent/1",
    },
  };
}
