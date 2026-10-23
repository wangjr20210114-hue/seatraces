/* 获取指定区域的 OSM 道路、水系和公园数据。 */

// Output is distributed under ODbL 1.0 with source, date and attribution retained.
import { mkdir, writeFile } from "node:fs/promises";
const areas = {
  suzhou: [31.28, 120.57, 31.35, 120.67],
  hangzhou: [30.19, 120.09, 30.28, 120.19],
  singapore: [1.26, 103.8, 1.34, 103.88],
  shanghai: [31.19, 121.42, 31.26, 121.56],
  beijing: [39.87, 116.26, 40.01, 116.43],
  chengdu: [30.63, 104.01, 30.69, 104.08],
  xian: [34.2, 108.93, 34.28, 108.98],
  kyoto: [34.98, 135.75, 35.04, 135.8],
  paris: [48.84, 2.28, 48.88, 2.36],
};
await mkdir("public/maps", { recursive: true });
for (const key of process.argv.slice(2).length
  ? process.argv.slice(2)
  : Object.keys(areas)) {
  const box = areas[key];
  if (!box) throw Error("Unknown area");
  const q = `[out:json][timeout:35];(way[highway~"^(primary|secondary|tertiary|residential)$"](${box.join(",")});way[waterway~"^(river|canal)$"](${box.join(",")});way[natural=water](${box.join(",")});way[leisure=park](${box.join(",")}););out tags geom;`;
  try {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: new URLSearchParams({ data: q }),
      headers: {
        "User-Agent": "SeaTraces-Prototype/0.1 (local educational project)",
      },
      signal: AbortSignal.timeout(55000),
    });
    if (!response.ok) throw Error("HTTP " + response.status);
    const data = await response.json();
    const features = data.elements
      .filter((e) => e.geometry?.length > 1)
      .map((e) => {
        const coords = e.geometry.map((p) => [p.lon, p.lat]),
          closed =
            coords.length > 3 &&
            coords[0][0] === coords.at(-1)[0] &&
            coords[0][1] === coords.at(-1)[1],
          polygon =
            closed &&
            (e.tags?.natural === "water" || e.tags?.leisure === "park");
        return {
          type: "Feature",
          id: e.id,
          properties: {
            name: e.tags?.["name:zh"] || e.tags?.name || "",
            kind: e.tags?.highway
              ? "road"
              : e.tags?.waterway || e.tags?.natural === "water"
                ? "water"
                : "park",
            class: e.tags?.highway || "",
          },
          geometry: {
            type: polygon ? "Polygon" : "LineString",
            coordinates: polygon ? [coords] : coords,
          },
        };
      });
    await writeFile(
      "public/maps/" + key + ".geojson",
      JSON.stringify({
        type: "FeatureCollection",
        attribution: "© OpenStreetMap contributors",
        license: "ODbL-1.0",
        source: "https://www.openstreetmap.org/copyright",
        timestamp: data.osm3s?.timestamp_osm_base || new Date().toISOString(),
        bbox: box,
        features,
      }),
    );
    console.log(key + ": " + features.length + " map features");
  } catch (e) {
    console.log(key + ": unavailable (" + e.message + "); use schematic map");
  }
}
