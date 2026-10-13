// Explicit live business-level acceptance. Up to 6 Amap + 1 DeepSeek requests.
// Uses a disposable local account and public OSM places; never saves vendor POIs.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import pg from "pg";
if (
  !process.argv.includes("--live") ||
  process.argv
    .slice(2)
    .some(
      (arg) => !["--live", "--maps-only", "--transit-only"].includes(arg),
    ) ||
  (process.argv.includes("--maps-only") &&
    process.argv.includes("--transit-only"))
) {
  console.log(
    "Explicit live test: node scripts/verify-provider-workflow.mjs --live [--maps-only | --transit-only]",
  );
  process.exit(0);
}
const mapsOnly = process.argv.includes("--maps-only");
const transitOnly = process.argv.includes("--transit-only");
const base = "http://127.0.0.1:8787/api";
let cookie = "",
  testUser = null;
const username = "providercheck_" + randomBytes(6).toString("hex");
const report = {
  at: new Date().toISOString(),
  scope: "live local application with disposable account and public OSM places",
  checks: [],
  accountRemoved: false,
};
const local = JSON.parse(
  await readFile(new URL("../.runtime/local.json", import.meta.url), "utf8"),
);
const client = new pg.Client({
  host: "127.0.0.1",
  port: local.port,
  database: "seatraces",
  user: "seatraces",
  password: local.password,
});
async function api(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Seatraces": "1",
      Cookie: cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (response.headers.get("set-cookie"))
    cookie = response.headers.get("set-cookie").split(";")[0];
  const data = await response.json();
  if (!response.ok)
    throw Error(`HTTP ${response.status}: ${path.split("?")[0]}`);
  return data;
}
async function check(name, fn) {
  const start = performance.now();
  try {
    const summary = await fn();
    report.checks.push({
      name,
      passed: true,
      elapsedMs: Math.round(performance.now() - start),
      summary,
    });
  } catch (error) {
    report.checks.push({
      name,
      passed: false,
      elapsedMs: Math.round(performance.now() - start),
      error: "业务返回或资料未满足验收条件；未记录供应商原始内容",
      ...(error.acceptanceSummary ? { summary: error.acceptanceSummary } : {}),
    });
  }
}
try {
  await client.connect();
  const before = await api("/status");
  report.reservedBefore = before.budget.reserved;
  assert.equal(before.providers.maps, "configured_unverified");
  assert.equal(before.providers.llm, "configured_unverified");
  const created = await api("/auth/register", {
    username,
    password: randomBytes(24).toString("hex"),
    nickname: "接口验收临时用户",
  });
  testUser = created.user.id;
  if (!mapsOnly && !transitOnly)
    await check("deepseek_question_bank", async () => {
      const data = await api("/questions");
      assert.match(data.source, /^DeepSeek/);
      assert.equal(data.questions.length, 3);
      assert.deepEqual(
        new Set(data.questions.map((x) => x.id)),
        new Set(["interests", "pace", "transport"]),
      );
      return {
        provider: "DeepSeek",
        allowedQuestionIds: true,
        questionCount: data.questions.length,
      };
    });
  // A railway station and a garden are far enough apart to exercise transit.
  // These are public OSM IDs verified in the current catalog, not vendor records.
  const transitEndpoints = [
    { id: "osm:node/5218876252" },
    { id: "osm:way/468359738" },
  ];
  const endpoints = [];
  for (const [index, name] of (transitOnly
    ? []
    : ["拙政园", "苏州博物馆"]
  ).entries())
    await check("osm_to_amap_match_" + index, async () => {
      const data = await api(
        "/catalog/search?" +
          new URLSearchParams({
            q: name,
            lat: "31.322",
            lng: "120.619",
            radius: "3000",
            region: "china",
            limit: "10",
          }),
      );
      assert.equal(data.status, "live");
      const place = data.items.find((p) => p.name === name);
      assert.ok(place);
      const matched = await api(
        "/places/" + encodeURIComponent(place.id) + "/match",
        {},
      );
      assert.equal(matched.status, "live");
      // Fixed sample: the downtown museum may be explicitly labeled its main site.
      // This simulates a user choosing that branch; it does not auto-merge entities.
      const acceptedNames = new Set([name, name + "(本馆)", name + "（本馆）"]);
      const candidate = matched.items.find(
        (p) =>
          p.routeToken && acceptedNames.has(p.name) && p.distanceMeters < 500,
      );
      assert.ok(candidate);
      endpoints.push({ id: place.id, token: candidate.routeToken });
      return {
        sourcePlaceId: place.id,
        status: matched.status,
        candidateCount: matched.items.length,
        selectionTokenIssued: true,
      };
    });
  for (const mode of transitOnly ? ["transit"] : ["walking", "transit"])
    await check("normalized_" + mode, async () => {
      // Nearby landmarks validate selected walking endpoints; transit uses a
      // separate station-to-garden fixture so it actually exercises a vehicle.
      const routeEndpoints = mode === "transit" ? transitEndpoints : endpoints;
      assert.equal(routeEndpoints.length, 2);
      const data = await api("/routes", {
        from: routeEndpoints[0].id,
        to: routeEndpoints[1].id,
        mode,
        strategy: "balanced",
        fromMatchToken: routeEndpoints[0].token,
        toMatchToken: routeEndpoints[1].token,
      });
      const acceptanceSummary = {
        status: data.status,
        alternatives: data.alternatives?.length ?? 0,
        segmentModes: (data.alternatives || []).map((a) =>
          a.segments.map((s) => s.mode),
        ),
        durationPresent: (data.alternatives || []).every(
          (a) => Number.isFinite(a.minutes) && a.minutes > 0,
        ),
        selectedEndpointsUsed: Boolean(
          data.endpointSelections?.from && data.endpointSelections?.to,
        ),
      };
      try {
        assert.equal(data.status, "live");
        assert.equal(data.provider, "高德地图");
        assert.ok(data.alternatives.length);
        if (mode === "walking")
          assert.ok(data.endpointSelections.from && data.endpointSelections.to);
        for (const alternative of data.alternatives) {
          assert.ok(alternative.segments.length);
          assert.ok(
            Number.isFinite(alternative.minutes) && alternative.minutes > 0,
          );
        }
        if (mode === "walking")
          assert.ok(data.alternatives.some((a) => a.hasCompleteGeometry));
        if (mode === "transit")
          assert.ok(
            data.alternatives.some((a) =>
              a.segments.some((s) =>
                ["bus", "metro", "train", "tram", "ferry"].includes(s.mode),
              ),
            ),
          );
      } catch (error) {
        error.acceptanceSummary = acceptanceSummary;
        throw error;
      }
      return acceptanceSummary;
    });
  const after = await api("/status");
  report.reservedAfter = after.budget.reserved;
  report.reservedDelta = Number(
    (report.reservedAfter - report.reservedBefore).toFixed(4),
  );
  report.budgetNote = "Local request reservation only; not vendor billing.";
} catch {
  report.failure =
    "Setup or workflow prerequisite failed; no secrets or raw vendor data recorded";
} finally {
  if (testUser) {
    const deleted = await client.query(
      "DELETE FROM users WHERE id=$1 AND username=$2 RETURNING id",
      [testUser, username],
    );
    report.accountRemoved = deleted.rowCount === 1;
  }
  await client.end();
  cookie = "";
}
report.passed = report.checks.filter((c) => c.passed).length;
report.failed = report.checks.filter((c) => !c.passed).length;
await writeFile(
  new URL(
    transitOnly
      ? "../validation/provider-transit-20261011.json"
      : "../validation/provider-workflow-20261011.json",
    import.meta.url,
  ),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (report.failed || report.failure || !report.accountRemoved)
  process.exitCode = 1;
