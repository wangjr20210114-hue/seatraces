// Read-only gateway transport. Cache decisions belong to services/catalog.
export function createOsmClient({
  env = process.env,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  return async function requestOsm(path, params = {}) {
    if (
      ![
        "/coverage",
        "/places",
        "/place",
        "/cluster-places",
        "/place-batch",
        "/site",
        "/site-coverage",
        "/hierarchy",
        "/hierarchy-coverage",
        "/entity-coverage",
      ].includes(path)
    )
      throw Object.assign(new Error("地点库接口路径未开放"), { status: 400 });
    const url = new URL(path, new URL(env.OSM_SERVICE_URL));
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetchImpl(url, {
      // A city query also annotates hierarchy/entity records after the SQL read.
      signal: AbortSignal.timeout(path === "/cluster-places" ? 40000 : 8000),
      redirect: "error",
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error("地点库查询失败"), {
        status: response.status,
        code: [
          "catalog_busy",
          "catalog_query_timeout",
          "catalog_unavailable",
        ].includes(data.code)
          ? data.code
          : "catalog_unavailable",
      });
    return data;
  };
}
export const requestOsm = createOsmClient();
