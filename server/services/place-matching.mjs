import { distance } from "../planner.mjs";
import { toGcj, toWgs } from "../../public/coordinates.js";
import { mainlandEligible } from "../route-model.mjs";
import { googlePlaceCandidates } from "../google-maps.mjs";
import { nameSimilarity } from "../domain/place-matching.mjs";
import { unavailable } from "../integrations/unavailable.mjs";
import { requestGooglePlaces } from "../integrations/google-client.mjs";
import { searchAmapAround } from "../integrations/amap.mjs";

export async function matchPlace(p) {
  if (!mainlandEligible(p)) {
    if (
      process.env.OVERSEAS_MAP_PROVIDER !== "google" ||
      !process.env.GOOGLE_MAPS_SERVER_KEY
    )
      return unavailable(
        "Google Maps",
        "境外地点匹配尚未启用，需要配置 Google Maps 服务端 Key 并启用 Places API（New）。",
      );
    const result = await requestGooglePlaces(p);
    const items = googlePlaceCandidates(result)
      .filter((x) => x.point && x.name)
      .map((x) => {
        const nameScore = Math.max(
          ...[p.name, ...(p.aliases || []), ...(p.editorialAliases || [])].map(
            (n) => nameSimilarity(n, x.name),
          ),
        );
        const meters = Math.round(
          distance(p, { lat: x.point[0], lng: x.point[1] }) * 1000,
        );
        const score = 0.65 * nameScore + 0.35 * Math.exp(-meters / 500);
        const { point, ...candidate } = x;
        return {
          ...candidate,
          routing: { provider: "google", id: x.id },
          nameScore: Number(nameScore.toFixed(3)),
          distanceMeters: meters,
          score: Number(score.toFixed(3)),
          confidence:
            score > 0.85 && meters < 300 ? "高相似 · 请核验" : "需人工核验",
        };
      })
      .filter((x) => x.distanceMeters <= 3000)
      .sort((a, b) => b.score - a.score);
    return {
      status: "live",
      provider: "Google Maps",
      items,
      checkedAt: new Date().toISOString(),
      message:
        "Google Maps 候选按名称、别名与空间距离排序；仅供核对，不自动写入 OSM 数据库。",
    };
  }
  if (!process.env.AMAP_KEY)
    return unavailable(
      "高德地图",
      "配置地图服务密钥后，可按名称、城市和距离匹配供应商地点。",
    );
  const r = await searchAmapAround({
    keywords: p.name,
    location: toGcj(p),
    radius: 3000,
    limit: 5,
    // Match the named entity before nearby entrances/shops fill the small page.
    sort: "weight",
  });
  const items = (r.pois || [])
    .map((x) => {
      const nameScore = Math.max(
          ...[p.name, ...(p.aliases || []), ...(p.editorialAliases || [])].map(
            (n) => nameSimilarity(n, x.name),
          ),
        ),
        wgs = toWgs(x.location)[0],
        meters = wgs
          ? Math.round(distance(p, { lat: wgs[0], lng: wgs[1] }) * 1000)
          : null,
        score =
          0.65 * nameScore +
          0.35 * (meters === null ? 0 : Math.exp(-meters / 500));
      return {
        id: x.id,
        name: x.name,
        address: typeof x.address === "string" ? x.address : "",
        type: x.type || null,
        coord_system: "GCJ02",
        routing: {
          provider: "amap",
          id: x.id,
          location: String(x.location || "")
            .split(",")
            .map(Number)
            .map((v) => v.toFixed(6))
            .join(","),
        },
        nameScore: Number(nameScore.toFixed(3)),
        distanceMeters: meters,
        score: Number(score.toFixed(3)),
        confidence:
          score > 0.85 && meters !== null && meters < 300
            ? "高相似 · 请核验"
            : "需人工核验",
      };
    })
    .sort((a, b) => b.score - a.score);
  return {
    status: "live",
    provider: "高德地图",
    items: items.filter(
      (x) => x.distanceMeters !== null && x.distanceMeters <= 3000,
    ),
    checkedAt: new Date().toISOString(),
    message:
      "按别名编辑距离与空间距离排序；候选仅供核对，不自动写入自有数据库。",
  };
}
