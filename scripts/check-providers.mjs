// Status is offline. --live performs at most four Amap + one DeepSeek calls.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import dotenv from "dotenv";
dotenv.config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});
const args = process.argv.slice(2);
if (
  args.some(
    (a) =>
      ![
        "--live",
        "--provider=all",
        "--provider=amap",
        "--provider=deepseek",
      ].includes(a),
  )
) {
  console.error(
    "Usage: node scripts/check-providers.mjs [--live] [--provider=all|amap|deepseek]",
  );
  process.exit(2);
}
const live = args.includes("--live"),
  provider =
    args.find((a) => a.startsWith("--provider="))?.split("=")[1] || "all";
const { providerStatus } = await import("../server/config/providers.mjs");
const report = {
  checkedAt: new Date().toISOString(),
  mode: live ? "live" : "configuration_only",
  configuration: {
    amap: providerStatus().maps,
    deepseek: providerStatus().llm,
    amapPoiVersion: process.env.AMAP_POI_VERSION || "v5",
    model: process.env.DEEPSEEK_MODEL || "deepseek-flash",
  },
  requestLimit: live ? { amap: 4, deepseek: 1 } : { amap: 0, deepseek: 0 },
  checks: [],
};
if (!live) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
const requested = ["amap", "deepseek"].filter(
  (p) => provider === "all" || provider === p,
);
const ready = requested.filter(
  (p) => process.env[p === "amap" ? "AMAP_KEY" : "DEEPSEEK_API_KEY"],
);
for (const p of requested.filter((p) => !ready.includes(p)))
  report.checks.push({ provider: p, status: "not_configured" });
let pool;
try {
  if (ready.length) {
    // This diagnostic deliberately targets the existing LOCAL application DB,
    // so it shares the same budget ledger and never invents an unmetered path.
    const local = JSON.parse(
      await readFile(
        new URL("../.runtime/local.json", import.meta.url),
        "utf8",
      ),
    );
    if (
      !Number.isSafeInteger(local.port) ||
      local.port < 1 ||
      local.port > 65535 ||
      typeof local.password !== "string"
    )
      throw new Error("local config invalid");
    process.env.DATABASE_URL = `postgresql://seatraces:${encodeURIComponent(local.password)}@127.0.0.1:${local.port}/seatraces`;
    ({ pool } = await import("../server/db.mjs"));
    await pool.query("SELECT 1 FROM api_usage LIMIT 0");
    async function check(p, operation, fn) {
      const start = performance.now();
      try {
        const summary = await fn();
        report.checks.push({
          provider: p,
          operation,
          status: "passed",
          elapsedMs: Math.round(performance.now() - start),
          summary,
        });
      } catch (e) {
        report.checks.push({
          provider: p,
          operation,
          status: "failed",
          elapsedMs: Math.round(performance.now() - start),
          message: e.status
            ? e.message
            : "响应不符合预期，请检查供应商权限与返回结构",
          providerCode: e.providerCode || null,
        });
      }
    }
    if (ready.includes("amap")) {
      const { amap, searchAmapText } = await import(
        "../server/integrations/amap.mjs"
      );
      await check("amap", "poi_search", async () => {
        const r = await searchAmapText({
          keywords: "拙政园",
          city: "苏州",
          limit: 1,
        });
        if (!Array.isArray(r.pois) || !r.pois.length)
          throw new Error("no sample");
        return { returnedPlaces: r.pois.length };
      });
      await check("amap", "reverse_geocode", async () => {
        const r = await amap("v3/geocode/regeo", {
          location: "120.628,31.324",
          extensions: "base",
          radius: 100,
        });
        if (!r.regeocode?.addressComponent?.citycode)
          throw new Error("missing city");
        return { cityCodeAvailable: true };
      });
      for (const mode of ["walking", "transit"])
        await check("amap", mode, async () => {
          // Public, fixed Suzhou test points in GCJ-02, not device/user locations.
          const r = await amap(
            mode === "walking"
              ? "v5/direction/walking"
              : "v5/direction/transit/integrated",
            {
              origin: "120.628,31.324",
              destination: "120.613,31.313",
              show_fields: "cost,polyline,navi",
              ...(mode === "transit"
                ? { city1: "0512", city2: "0512", strategy: "0" }
                : {}),
            },
          );
          const alternatives =
            mode === "walking" ? r.route?.paths : r.route?.transits;
          if (!Array.isArray(alternatives) || !alternatives.length)
            throw new Error("no route");
          return { returnedRoutes: alternatives.length };
        });
    }
    if (ready.includes("deepseek")) {
      const { llmJSON } = await import("../server/integrations/deepseek.mjs");
      await check("deepseek", "structured_json", async () => {
        const r = await llmJSON(
          '仅将输入中的 checkId 原样返回为 {"checkId":"..."}。',
          { checkId: "seatraces-connectivity" },
        );
        if (r.checkId !== "seatraces-connectivity")
          throw new Error("unexpected output");
        return { jsonValidated: true };
      });
    }
  }
} catch {
  report.checks.push({
    provider: "local_budget",
    status: "failed",
    message: "本机预算台账尚未就绪；请先启动本机后端。未绕过预算执行后续调用。",
  });
} finally {
  if (pool) await pool.end();
}
console.log(JSON.stringify(report, null, 2));
if (report.checks.some((c) => c.status !== "passed")) process.exitCode = 1;
