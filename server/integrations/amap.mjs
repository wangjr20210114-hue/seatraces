import { request } from "./http.mjs";
import { toGcj } from "../../public/coordinates.js";
import { createPacedQueue } from "./paced-queue.mjs";

const allowedPaths = new Set([
  "v3/config/district",
  "v3/place/text",
  "v3/place/around",
  "v5/place/text",
  "v5/place/around",
  "v5/place/detail",
  "v3/geocode/regeo",
  "v5/direction/walking",
  "v5/direction/transit/integrated",
  "v5/direction/driving",
  "v5/direction/bicycling",
]);

const sharedSchedule = createPacedQueue();
export function createAmapClient({
  requestJSON = request,
  env = process.env,
  schedule = sharedSchedule,
  provider = "Amap",
} = {}) {
  async function call(path, params = {}) {
    if (!allowedPaths.has(path))
      throw Object.assign(new Error("高德接口路径未开放"), { status: 400 });
    if (!env.AMAP_KEY)
      throw Object.assign(new Error("高德 Web 服务 Key 尚未配置"), {
        status: 503,
      });
    const clean = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
    );
    const result = await schedule(() =>
      requestJSON(
        provider,
        "https://restapi.amap.com/" +
          path +
          "?" +
          new URLSearchParams({ ...clean, key: env.AMAP_KEY }),
      ),
    );
    if (result?.status !== "1") {
      const code = /^\d{5}$/.test(String(result?.infocode))
        ? String(result.infocode)
        : "unknown";
      const rateLimited = [
        "10019",
        "10020",
        "10021",
        "10022",
        "10023",
      ].includes(code);
      throw Object.assign(
        new Error(
          rateLimited
            ? "地图请求较密，请稍后重试路线"
            : `高德服务暂不可用（错误码 ${code}）`,
        ),
        {
          status: rateLimited ? 429 : 502,
          providerCode: code,
        },
      );
    }
    return result;
  }
  function version() {
    const value = env.AMAP_POI_VERSION || "v5"; // Preserve existing matching behavior.
    if (!["v3", "v5"].includes(value))
      throw Object.assign(new Error("AMAP_POI_VERSION 必须为 v3 或 v5"), {
        status: 503,
      });
    return value;
  }
  function pageSize(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25)
      throw Object.assign(new Error("地点查询数量必须为 1–25"), {
        status: 400,
      });
    return limit;
  }
  async function searchAround({
    keywords,
    location,
    radius = 3000,
    limit = 5,
    sort = "distance",
    details = false,
  }) {
    if (!["distance", "weight"].includes(sort))
      throw Object.assign(new Error("地点排序方式无效"), { status: 400 });
    const v = version(),
      size = pageSize(limit);
    return call(`${v}/place/around`, {
      keywords,
      location,
      radius,
      sortrule: sort,
      ...(details && v === "v5" ? { show_fields: "business" } : {}),
      ...(v === "v5" ? { page_size: size } : { offset: size, page: 1 }),
    });
  }
  async function searchText({ keywords, city, limit = 5 }) {
    if (
      typeof keywords !== "string" ||
      !keywords.trim() ||
      keywords.length > 80
    )
      throw Object.assign(new Error("请输入 1–80 字符的地点关键词"), {
        status: 400,
      });
    const v = version(),
      size = pageSize(limit);
    return call(`${v}/place/text`, {
      keywords,
      ...(v === "v5"
        ? { region: city, city_limit: Boolean(city), page_size: size }
        : { city, citylimit: Boolean(city), offset: size, page: 1 }),
    });
  }
  return { call, searchAround, searchText };
}
const client = createAmapClient({
  provider:
    process.env.AMAP_BATCH_MODE === "parent_catalog" ? "AmapParent" : "Amap",
});
export const amap = client.call;
export const searchAmapAround = client.searchAround;
export const searchAmapText = client.searchText;

const codes = {
  苏州: "0512",
  杭州: "0571",
  上海: "021",
  北京: "010",
  成都: "028",
  西安: "029",
};
export async function cityCode(point, selectedLocation = null) {
  if (!selectedLocation && codes[point.city]) return codes[point.city];
  const result = await amap("v3/geocode/regeo", {
    location: selectedLocation || toGcj(point),
    extensions: "base",
    radius: "100",
  });
  const code = result.regeocode?.addressComponent?.citycode;
  return typeof code === "string" && /^\d{2,5}$/.test(code) ? code : null;
}
