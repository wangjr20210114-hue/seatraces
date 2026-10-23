/* 将服务价格信息匹配到对应地点。 */

import { nameSimilarity } from "./place-matching.mjs";
import { metres } from "./trip-services.mjs";
import { toWgs } from "../../public/coordinates.js";

export function matchServicePrice(place, pois, now = new Date().toISOString()) {
  const candidates = (pois || [])
    .flatMap((p) => {
      if (
        !p.id ||
        typeof p.name !== "string" ||
        !/^[-\d.]+,[-\d.]+$/.test(p.location || "")
      )
        return [];
      const validType =
        place.classification.category === "food"
          ? /^05/.test(p.typecode || "") || /餐饮/.test(p.type || "")
          : /^10/.test(p.typecode || "") || /住宿/.test(p.type || "");
      if (!validType) return [];
      const wgs = toWgs(p.location)[0];
      if (!wgs) return [];
      const distance = metres(place, { lat: wgs[0], lng: wgs[1] });
      const similarity = Math.max(
        ...[place.name, ...(place.aliases || [])]
          .filter((x) => typeof x === "string")
          .map((n) => {
            const exact = nameSimilarity(n, p.name);
            const branchless =
              distance <= 100 && !/[（(]/.test(n)
                ? nameSimilarity(
                    n,
                    p.name.replace(/[（(][^()（）]*[)）]$/u, ""),
                  )
                : 0;
            return Math.max(exact, branchless === 1 ? 1 : 0);
          }),
      );
      if (distance > 250 || similarity < 0.85) return [];
      return [
        {
          p,
          distance,
          similarity,
          score: 0.7 * similarity + 0.3 * Math.exp(-distance / 150),
        },
      ];
    })
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || (candidates[1] && best.score - candidates[1].score < 0.08))
    return {
      status: "unmatched",
      amount: null,
      currency: "CNY",
      unit: "per_person",
      provider: "amap",
      checkedAt: now,
    };
  const raw = best.p.business?.cost ?? best.p.biz_ext?.cost;
  const amount =
    (typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw.trim())) ||
    typeof raw === "number"
      ? Number(raw)
      : NaN;
  return {
    status:
      Number.isFinite(amount) && amount > 0 && amount <= 100000
        ? "available"
        : "unavailable",
    amount:
      Number.isFinite(amount) && amount > 0 && amount <= 100000 ? amount : null,
    currency: "CNY",
    unit: "per_person",
    provider: "amap",
    providerId: best.p.id,
    matchedName: best.p.name,
    matchDistanceMeters: Math.round(best.distance),
    matchScore: Number(best.score.toFixed(3)),
    checkedAt: now,
    sourceUpdatedAt: null,
  };
}
