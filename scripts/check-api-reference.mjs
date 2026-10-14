// Keep the end-to-end documentation inventory tied to installed HTTP routes.
import { readFile, writeFile } from "node:fs/promises";
const files = [
  "server/index.mjs",
  "server/auth.mjs",
  "server/services/journey-service.mjs",
  "server/services/citywalk-service.mjs",
  "server/services/trip-services.mjs",
  "server/frontend.mjs",
];
const reference = await readFile("API_REFERENCE.md", "utf8"),
  endpoints = [],
  missing = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const m of source.matchAll(
    /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*(\[[^\]]+\]|['"][^'"]+['"])/g,
  )) {
    for (const p of m[2].matchAll(/['"]([^'"]+)['"]/g)) {
      const path = (file.endsWith("/auth.mjs") ? "/api" : "") + p[1];
      if (
        !path.startsWith("/api/") &&
        !["/_AMapService/v4/map/styles", "/frontend-health"].includes(path)
      )
        continue;
      const method = m[1].toUpperCase(),
        key = method + " " + path;
      if (endpoints.some((e) => e.method + " " + e.path === key)) continue;
      const short = path.replace(/^\/api\//, "/");
      if (
        !reference.includes(method + " " + path) &&
        !reference.includes(method + " " + short) &&
        path !== "/_AMapService/v4/map/styles"
      )
        missing.push(key);
      endpoints.push({
        method,
        path,
        source: file,
        line: source.slice(0, m.index).split("\n").length,
        reference: "API_REFERENCE.md",
      });
    }
  }
}
if (missing.length)
  throw Error("API reference entries missing: " + missing.join(", "));
await writeFile(
  "contracts/api-inventory.json",
  JSON.stringify(
    {
      schemaVersion: "api-inventory/1",
      description:
        "已安装的业务HTTP入口清单；参数、返回与副作用见API_REFERENCE.md。不是agent工具注册表。",
      endpoints,
    },
    null,
    2,
  ) + "\n",
);
console.log("Documented HTTP operations: " + endpoints.length);
