/* 检查不同地区和类别的候选地点检索结果。 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import pg from "pg";
const allSamples = [
  {
    id: "suzhou",
    label: "知名景点：拙政园",
    q: "拙政园",
    lat: 31.324,
    lng: 120.624,
  },
  {
    id: "shanghai",
    label: "知名景点：外滩",
    q: "外滩",
    lat: 31.24,
    lng: 121.49,
  },
  {
    id: "jingdezhen",
    label: "景德镇：中国陶瓷博物馆",
    q: "景德镇中国陶瓷博物馆",
    lat: 29.294,
    lng: 117.204,
  },
  {
    id: "chaozhou",
    label: "潮州：广济桥",
    q: "广济桥",
    lat: 23.661,
    lng: 116.645,
  },
  {
    id: "quzhou_named",
    label: "衢州：孔庙",
    q: "孔庙",
    city: "衢州",
    lat: 28.96,
    lng: 118.875,
  },
  {
    id: "quzhou_discover",
    label: "衢州：周边景点候选",
    q: "",
    intent: "discover",
    lat: 28.96,
    lng: 118.875,
  },
];
const args = process.argv.slice(2),
  selected = args.find((x) => x.startsWith("--sample="))?.slice(9);
if (
  !args.includes("--live") ||
  args.some((x) => x !== "--live" && x !== `--sample=${selected}`) ||
  (selected && !allSamples.some((s) => s.id === selected))
) {
  console.log("node scripts/check-candidates.mjs --live [--sample=sample_id]");
  process.exit(0);
}
const samples = selected
  ? allSamples.filter((s) => s.id === selected)
  : allSamples;
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
const username = "candidatecheck_" + randomBytes(5).toString("hex");
let cookie = "",
  userId;
async function api(path, body) {
  const r = await fetch("http://127.0.0.1:8787/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Seatraces": "1",
      Cookie: cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(35000),
  });
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  if (!r.ok) throw Error("HTTP " + r.status);
  return r.json();
}
const report = {
  at: new Date().toISOString(),
  scope:
    "bounded live candidate search; fixed approximate area centers in WGS84",
  samples: [],
  accountRemoved: false,
};
try {
  await client.connect();
  report.reservedBefore = (await api("/status")).budget.reserved;
  const created = await api("/auth/register", {
    username,
    password: randomBytes(24).toString("hex"),
    nickname: "候选验收临时用户",
  });
  userId = created.user.id;
  for (const sample of samples) {
    const { id, label, ...request } = sample;
    const start = performance.now();
    let summary;
    try {
      const result = await api("/catalog/candidates", {
        ...request,
        countryCode: "CN",
        category: "scenic",
        radius: 15000,
        limit: 10,
      });
      summary = {
        id,
        label,
        elapsedMs: Math.round(performance.now() - start),
        status: result.status,
        local: result.local,
        sufficiency: result.sufficiency,
        fallback: result.fallback,
        embedding: result.embedding,
        semanticScores: result.items.map((p) => ({
          cosine: p.match.semanticSimilarity,
          requiresNameConfirmation: p.match.requiresNameConfirmation,
        })),
        returned: result.items.length,
        bySource: {
          osm: result.items.filter((p) => p.id.startsWith("osm:")).length,
          amap: result.items.filter((p) => p.id.startsWith("amap:")).length,
        },
        missingFields: [
          ...new Set(result.items.flatMap((p) => p.quality.missingForTravel)),
        ],
      };
      assert.ok(["ready", "needs_selection"].includes(result.status));
      if (result.status === "needs_selection")
        assert.equal(result.sufficiency.requiresSelection, true);
      assert.equal(result.sufficiency.sufficient, true);
      assert.ok(result.fallback.requests <= 1);
      for (const p of result.items) {
        assert.equal(p.schemaVersion, "place-candidate/1");
        assert.equal(p.location.point.crs, "WGS84");
        assert.ok(p.quality.searchUsable && p.match.withinRequestedRadius);
        assert.ok(p.sources.length);
        for (const fact of Object.values(p.facts))
          if (fact.value !== null) assert.ok(fact.sourceRef);
        if (p.id.startsWith("amap:"))
          assert.equal(p.sources[0].persistence, "request_only");
      }
      if (id === "suzhou") {
        const osm = result.items.find((p) => p.id.startsWith("osm:"));
        if (osm)
          await writeFile(
            new URL(
              "../validation/candidate-osm-example-20261011.json",
              import.meta.url,
            ),
            JSON.stringify(osm, null, 2) + "\n",
          );
      }
      report.samples.push({ ...summary, passed: true });
    } catch {
      report.samples.push({
        ...summary,
        id,
        label,
        passed: false,
        elapsedMs: Math.round(performance.now() - start),
        error: "未满足本次候选数量或结构要求；不保存原始高德内容",
      });
    }
  }
  report.reservedAfter = (await api("/status")).budget.reserved;
  report.reservedDelta = Number(
    (report.reservedAfter - report.reservedBefore).toFixed(4),
  );
  report.budgetNote = "Local reservation estimate, not vendor billing.";
} catch {
  report.error = "验收前置条件失败；未输出凭据";
} finally {
  if (userId)
    report.accountRemoved =
      (
        await client.query(
          "DELETE FROM users WHERE id=$1 AND username=$2 RETURNING id",
          [userId, username],
        )
      ).rowCount === 1;
  await client.end();
  cookie = "";
}
report.passed = report.samples.filter((s) => s.passed).length;
report.failed = report.samples.filter((s) => !s.passed).length;
await writeFile(
  new URL(
    `../validation/candidate-live-20261011${selected ? "-" + selected : ""}.json`,
    import.meta.url,
  ),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (report.failed || report.error || !report.accountRemoved)
  process.exitCode = 1;
