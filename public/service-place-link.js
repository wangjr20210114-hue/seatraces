/* 根据服务地点信息生成地图详情链接。 */

import { hasPosition } from "./trip-view.js";
export function servicePlaceUrl(place) {
  if (!hasPosition(place)) return null;
  return (
    "https://uri.amap.com/marker?" +
    new URLSearchParams({
      position: `${Number(place.lng)},${Number(place.lat)}`,
      name: String(place.name || ""),
      coordinate: place.crs === "GCJ02" ? "gaode" : "wgs84",
      src: "SeaTraces",
      callnative: "1",
    })
  );
}
