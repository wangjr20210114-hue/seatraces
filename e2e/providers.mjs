// Synthetic transport fixtures, not verified destination/price/route data.
// Business routes, clustering, persistence and frontend remain real.
const places = [
  ["UI江边展馆", "attraction", 121.484, 31.233],
  ["UI街角公园", "nature", 121.486, 31.234],
  ["UI小型博物馆", "heritage", 121.488, 31.234],
  ["UI步行商业街", "shopping", 121.489, 31.235],
  ["UI咖啡馆", "food", 121.49, 31.236],
].map(([name, category, lng, lat], i) => ({
  id: "osm:node/" + (9900000000 + i),
  name,
  category,
  lng,
  lat,
  city: "上海",
  country: "CN",
  region: "china",
  coord_system: "WGS84",
  source: "ui-fixture",
  duration_min: 45,
  traits: ["culture"],
  aliases: [],
  children: [],
}));
const json = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
export function providerFixture(url) {
  if (url.hostname === "127.0.0.1" && url.port === "19890") {
    const category = url.searchParams.get("category");
    const items = places.filter((p) =>
      !category || category === "scenic" ? true : p.category === category,
    );
    if (url.pathname === "/place")
      return json({
        status: "live",
        item: places.find((p) => p.id === url.searchParams.get("id")) || null,
      });
    if (["/places", "/cluster-places", "/place-batch"].includes(url.pathname))
      return json({
        status: "live",
        items,
        coverageStatus: "within_requested_bbox",
      });
    return json({ status: "live", items: [], relations: [] });
  }
  if (url.hostname === "restapi.amap.com") {
    if (url.pathname === "/v3/config/district") {
      const name = url.searchParams.get("keywords") || "上海";
      return json({
        status: "1",
        infocode: "10000",
        districts: [
          {
            name,
            level: "city",
            adcode: "310000",
            center: "121.48,31.24",
            polyline:
              "121.40,31.18;121.58,31.18;121.58,31.30;121.40,31.30;121.40,31.18",
            districts: [],
          },
        ],
      });
    }
    // Deliberately unavailable: no fake walking distance may be saved as verified.
    return json({
      status: "0",
      infocode: "10001",
      info: "TEST_PROVIDER_UNAVAILABLE",
    });
  }
  return null;
}
