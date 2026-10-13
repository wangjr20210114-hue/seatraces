import { requestOsm } from "../integrations/osm.mjs";
import {
  rememberCatalog,
  cachedCatalog,
} from "../repositories/catalog-cache.mjs";
import { findLocalPlace } from "../repositories/places.mjs";
const withoutLegacyCount = (value) => {
  if (!("hasMore" in value)) return value;
  const { hasMore, ...rest } = value;
  return rest;
};

export function createCatalogService({
  requestSource = requestOsm,
  remember = rememberCatalog,
  cached = cachedCatalog,
  findLocal = findLocalPlace,
  env = process.env,
} = {}) {
  async function catalogRequest(path, params = {}) {
    if (!env.OSM_SERVICE_URL)
      return {
        status: "not_configured",
        items: [],
        message: "云端地点库连接尚未配置；请配置 OSM_SERVICE_URL。",
      };
    try {
      const data = withoutLegacyCount(await requestSource(path, params));
      remember(path, params, data);
      return data;
    } catch (e) {
      if (e.status === 400) throw e;
      const saved = cached(path, params);
      if (saved) {
        const payload = withoutLegacyCount(saved.payload);
        return {
          ...payload,
          status: "snapshot",
          scope: "cached_query_only",
          cachedAt: saved.at,
          elapsedMs: null,
          message:
            "云端连接不可用，显示本机最近一次成功查询的 OSM 缓存；仅覆盖已查过的地点，不代表完整离线数据库。",
        };
      }
      if (e.status === 429 || e.status === 504)
        throw Object.assign(
          Error(
            e.status === 429
              ? "地点查询繁忙，请稍后重试"
              : "地点查询超时，请缩小范围重试",
          ),
          { status: e.status, code: e.code },
        );
      throw Object.assign(
        Error("云端地点库连接中断或查询超时，请检查服务连接。"),
        { status: 503, code: "catalog_unavailable" },
      );
    }
  }
  async function resolvePlace(id) {
    if (id.startsWith("osm:")) {
      const r = await catalogRequest("/place", { id });
      if (r.status === "not_configured")
        throw Object.assign(Error(r.message), { status: 503 });
      return r.item
        ? { ...r.item, cacheStatus: r.status, cachedAt: r.cachedAt }
        : null;
    }
    return findLocal(id);
  }
  return { catalogRequest, resolvePlace };
}
const service = createCatalogService();
export const catalogRequest = service.catalogRequest;
export const resolvePlace = service.resolvePlace;
