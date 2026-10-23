/* 查询交通路线，统一路段、换乘和耗时信息。 */

import { distance } from "../planner.mjs";
import { toWgs } from "../../public/coordinates.js";
import {
  transitAlternatives,
  pathAlternatives,
  rankAlternatives,
  mainlandEligible,
} from "../route-model.mjs";
import { amapEndpointParams } from "../route-selection.mjs";
import { googleAlternatives } from "../google-maps.mjs";
import { requestGoogleRoute } from "../integrations/google-client.mjs";
import { amap, cityCode } from "../integrations/amap.mjs";

export function demoRoute(a, b) {
  const km = distance(a, b) * 1.35;
  return {
    status: "estimated",
    provider: "本地距离估算",
    message:
      "虚线路线只表示地点顺序，不是可执行的道路导航。请打开地图 App 获取实际路线。",
    alternatives: [
      {
        label: "步行估算",
        minutes: Math.max(1, Math.round((km / 4) * 60)),
        distanceKm: Number(km.toFixed(1)),
        segments: [
          {
            mode: "walk",
            instruction: `从 ${a.name} 前往 ${b.name}；实际转向请以地图 App 为准。`,
            minutes: Math.max(1, Math.round((km / 4) * 60)),
            polyline: [
              [a.lat, a.lng],
              [b.lat, b.lng],
            ],
          },
        ],
      },
    ],
  };
}
export const normalizeTransit = (transits) =>
  transitAlternatives(transits, toWgs);
export async function route(
  a,
  b,
  strategy = "balanced",
  mode = "walking",
  departure = null,
  timeZone = null,
  selections = {},
) {
  if (!["walking", "transit", "driving", "cycling"].includes(mode))
    throw Object.assign(Error("出行方式无效"), { status: 400 });
  if (!mainlandEligible(a) || !mainlandEligible(b)) {
    if (
      process.env.OVERSEAS_MAP_PROVIDER !== "google" ||
      !process.env.GOOGLE_MAPS_SERVER_KEY
    )
      return {
        ...demoRoute(a, b),
        reason: "coverage_unavailable",
        message:
          "境外 Google Maps 服务尚未启用或配置。当前仅为距离估算；真实换乘、道路和导航仍不可用。",
        destination: b,
      };
    const { body, result } = await requestGoogleRoute(a, b, {
      strategy,
      mode,
      departure,
      timeZone,
      selections,
    });
    const alternatives = googleAlternatives(result, mode, strategy);
    return {
      status: alternatives.length ? "live" : "no_result",
      provider: "Google Maps",
      mapProvider: "google",
      checkedAt: new Date().toISOString(),
      departure,
      departureTime: body.departureTime || null,
      alternatives,
      destination: b,
      coordinateSystem: "WGS84",
      mapCoordinateSystem: "WGS84",
      warnings: [...new Set(alternatives.flatMap((a) => a.warnings || []))],
      message: alternatives.length
        ? "Google Maps 提供的候选方案；仅对返回方案排序，未证明全路网最短或次短路径。班次与预计耗时可能变化。"
        : "供应商未返回包含必要路段的可用路线，请调整出发时间或出行方式。",
      travelNotice: ["walking", "cycling"].includes(mode)
        ? "步行与骑行路线可能缺少人行道或自行车道信息，请核对现场道路条件。"
        : null,
      entranceWarning: [a, b].some(
        (p) => p.coordinate_role === "representative_point_not_entrance",
      )
        ? "地点坐标是区域代表点，请核实实际出入口。"
        : null,
    };
  }
  if (!process.env.AMAP_KEY)
    return {
      ...demoRoute(a, b),
      reason: "not_configured",
      message:
        "高德 Web 服务 Key 尚未配置。估算仅用于行程草稿，不能用于道路导航。",
      destination: b,
    };
  const params = {
    ...amapEndpointParams(a, b, mode, selections),
    show_fields: "cost,polyline,navi",
  };
  let path = {
    walking: "walking",
    transit: "transit/integrated",
    driving: "driving",
    cycling: "bicycling",
  }[mode];
  if (mode === "transit") {
    params.city1 = await cityCode(a, selections.from?.location);
    params.city2 =
      !selections.from && !selections.to && a.city && a.city === b.city
        ? params.city1
        : await cityCode(b, selections.to?.location);
    if (!params.city1 || !params.city2)
      return {
        status: "no_result",
        provider: "高德地图",
        message: "未能核实公交城市编码，请打开地图 App 查询。",
        alternatives: [],
        destination: b,
      };
    params.strategy =
      { balanced: "0", fewTransfers: "2", fewWalking: "3", fastest: "8" }[
        strategy
      ] || "0";
    params.AlternativeRoute = "5";
    if (departure) {
      params.date = departure.slice(0, 10);
      params.time = departure.slice(11, 16).replace(":", "-");
    }
  } else if (mode === "driving")
    params.strategy = strategy === "fastest" ? "38" : "32";
  else params.alternative_route = "3";
  const result = await amap("v5/direction/" + path, params);
  const alternatives = rankAlternatives(
    mode === "transit"
      ? normalizeTransit(result.route?.transits)
      : pathAlternatives(result.route?.paths, mode, toWgs),
    strategy,
  );
  return {
    status: alternatives.length ? "live" : "no_result",
    provider: "高德地图",
    mapProvider: "amap",
    checkedAt: new Date().toISOString(),
    departure,
    alternatives,
    destination: b,
    coordinateSystem: "WGS84",
    mapCoordinateSystem: "GCJ02",
    message:
      "按供应商返回的备选方案排序；未证明全路网的最短或次短路径。实际时间受路况、候车与班次影响。",
    entranceWarning: [a, b].some(
      (p) => p.coordinate_role === "representative_point_not_entrance",
    )
      ? "地点坐标是区域代表点，请核实实际出入口。"
      : null,
  };
}
