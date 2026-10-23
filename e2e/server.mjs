/* 启动端到端测试数据库、前端和业务服务。 */

import EmbeddedPostgres from "embedded-postgres";
import { mkdir, mkdtemp, writeFile, unlink, rm, cp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import bcrypt from "bcryptjs";
import { providerFixture } from "./providers.mjs";
import { runNative } from "./native-runner.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const runtime = path.join(root, ".runtime/ui-test");
const dbPort=Number(process.env.UI_DB_PORT||55439);
if(!Number.isInteger(dbPort)||dbPort<1024||dbPort>65535||[19887,19888,54329].includes(dbPort))throw Error('Invalid isolated UI database port');
await mkdir(runtime, { recursive: true });
for (const port of [19887, 19888, dbPort])
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", () =>
      reject(
        Error(`UI test port ${port} is occupied; stop the earlier test first.`),
      ),
    );
    s.listen(port, "127.0.0.1", () => s.close(resolve));
  });
const dir = await mkdtemp(path.join(runtime, "db-")),
  password = randomBytes(24).toString("hex");
const appParent = path.join(root, "reports/ui");
await mkdir(appParent, { recursive: true });
const appRoot = await mkdtemp(path.join(appParent, "app-"));
for (const name of ["server", "public"])
  await cp(path.join(root, name), path.join(appRoot, name), {
    recursive: true,
  });
await cp(
  path.join(root, "data/editorial"),
  path.join(appRoot, "data/editorial"),
  { recursive: true },
);
await cp(path.join(root, "package.json"), path.join(appRoot, "package.json"));
const appImport = (name) =>
  import(pathToFileURL(path.join(appRoot, name)).href);
const db = new EmbeddedPostgres({
  databaseDir: dir,
  user: "seatraces_ui",
  password,
  port: dbPort,
  persistent: false,
  authMethod: "scram-sha-256",
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: [
    "-c",
    "listen_addresses=127.0.0.1",
    "-c",
    "shared_buffers=32MB",
    "-c",
    "max_connections=20",
  ],
  onLog: (m) => {
    if (/FATAL|ERROR/.test(String(m))) console.error(String(m));
  },
  onError: (e) => console.error("Test PostgreSQL:", e.message || e.code),
});
let front,
  backend,
  pool,
  stopRecommendationWorker,
  stopping = false;
const startedAt = Date.now();
let peakRss = 0,
  peakHeap = 0;
const sample = () => {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  peakHeap = Math.max(peakHeap, m.heapUsed);
};
const memoryTimer = setInterval(sample, 1000);
memoryTimer.unref();
sample();
async function stopDatabase() {
  if (process.platform === "win32" && db.process) {
    const { pg_ctl } = await import("@embedded-postgres/windows-x64");
    await promisify(execFile)(
      pg_ctl,
      ["-D", dir, "-m", "fast", "-w", "-t", "15", "stop"],
      { windowsHide: true, timeout: 20000 },
    );
    db.process = undefined;
    if (path.dirname(dir) !== runtime || !path.basename(dir).startsWith("db-"))
      throw Error("Invalid test cleanup target");
    await rm(dir, { recursive: true, force: true });
  } else await db.stop();
}
async function stop() {
  if (stopping) return;
  stopping = true;
  stopRecommendationWorker?.();
  front?.closeAllConnections();
  backend?.closeAllConnections();
  await Promise.all(
    [front, backend].filter(Boolean).map((s) => new Promise((r) => s.close(r))),
  );
  await pool?.end().catch(() => {});
  await stopDatabase();
  clearInterval(memoryTimer);
  sample();
  await mkdir(path.join(root, "reports/ui"), { recursive: true });
  await writeFile(
    path.join(root, "reports/ui/runtime-metrics.json"),
    JSON.stringify(
      {
        sampledAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        peakRssMB: Math.round(peakRss / 1048576),
        peakHeapMB: Math.round(peakHeap / 1048576),
        scope:
          "Node backend plus harness only; excludes native test child processes, PostgreSQL and browsers; sampled each second; synthetic small catalog",
      },
      null,
      2,
    ),
  );
  if (
    path.dirname(appRoot) !== appParent ||
    !path.basename(appRoot).startsWith("app-")
  )
    throw Error("Invalid test source cleanup target");
  await rm(appRoot, { recursive: true, force: true });
  await unlink(path.join(runtime, "state.json")).catch(() => {});
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  await db.initialise();
  await db.start();
  const setup = db.getPgClient("postgres", "127.0.0.1");
  try {
    await setup.connect();
    await setup.query("CREATE DATABASE seatraces_ui");
    await setup.query(`CREATE ROLE seatraces LOGIN PASSWORD '${password}'`);
    await setup.query("CREATE DATABASE seatraces OWNER seatraces");
  } finally {
    await setup.end();
  }
  for (const k of Object.keys(process.env))
    if (
      /^(AMAP|DEEPSEEK|GOOGLE|OSM|SMTP|MAIL|JUHE|AMADEUS|TRUST_PROXY|DATABASE_URL|SKIP_MIGRATIONS|REQUIRE_POSTGIS)/.test(
        k,
      )
    )
      delete process.env[k];
  Object.assign(process.env, {
    DOTENV_CONFIG_PATH: path.join(runtime, "no-env-file"),
    DATABASE_URL: `postgresql://seatraces_ui:${password}@127.0.0.1:${dbPort}/seatraces_ui`,
    NODE_ENV: "test",
    APP_ORIGIN: "http://127.0.0.1:19888",
    PORT: "19887",
    HOST: "127.0.0.1",
    AMAP_PARENT_LOOKUP_ENABLED: "false",
    SCENIC_MODEL_GROUPING_ENABLED: "false",
    OSM_SERVICE_URL: "http://127.0.0.1:19890",
    AMAP_KEY: "ui-test-no-real-key",
    ...(process.env.UI_PLANNER_MODEL === '1' ? {DEEPSEEK_API_KEY: 'ui-planner-fixture'} : {}),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const fixture = providerFixture(url, init);
    if (fixture) return Promise.resolve(fixture);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw Error("External network is disabled in UI regression");
    return originalFetch(input, init);
  };
  ({ server: backend,stopRecommendationWorker } = await appImport("server/index.mjs"));
  const database = await appImport("server/db.mjs");
  pool = database.pool;
  const q = database.query;
  const hash = (s) => createHash("sha256").update(s).digest("hex");
  const credentials = {
    password: "Ui-fixture-" + randomBytes(9).toString("hex"),
  };
  const digest = await bcrypt.hash(credentials.password, 4);
  for (const role of ["a", "b", "admin"]) {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      username = "ui_" + role;
    await q(
      "INSERT INTO users(id,username,password_hash,nickname,role) VALUES($1,$2,$3,$4,$5)",
      [
        id,
        username,
        digest,
        "UI测试" + role,
        role === "admin" ? "admin" : "user",
      ],
    );
    await q(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '4 hours')",
      [hash(token), id],
    );
    credentials[role] = { id, username, token };
    if (role === "admin") {
      const adminToken = randomBytes(32).toString("hex");
      credentials.admin.adminToken = adminToken;
      await q(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')",
        [hash("admin-session:" + adminToken), id],
      );
    }
  }
  const stops = [
    {
      id: "ui-bund",
      name: "外滩",
      city: "上海",
      country: "CN",
      category: "attraction",
      lng: 121.4902,
      lat: 31.2401,
      coord_system: "GCJ02",
      arrive: "09:00",
      depart: "10:00",
    },
    {
      id: "ui-street",
      name: "南京东路",
      city: "上海",
      country: "CN",
      category: "shopping",
      lng: 121.4788,
      lat: 31.2383,
      coord_system: "GCJ02",
      arrive: "10:30",
      depart: "11:30",
    },
  ];
  const start = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
  const plan = {
    schemaVersion: "journey/2",
    title: "UI上海两日行程",
    cities: [
      {
        id: "shanghai",
        name: "上海",
        country: "CN",
        lat: 31.2304,
        lng: 121.4737,
      },
    ],
    days: [
      { date: start, city: "上海", stops: stops.map(p=>({...p,category:'attraction'})), legs: [] },
      { date: start, city: "上海", stops: [...stops].reverse().map(p=>({...p,category:'attraction'})), legs: [] },
    ],
    services: {},
    warnings: [],
  };
  const trip = randomUUID(),
    post = randomUUID(),
    walk = randomUUID();
  const request = {
    origin: { label: "北京", lat: 39.9, lng: 116.4 },
    cities: ["shanghai"],
    start,
    end: start,
    days: 2,
  };
  await q(
    "INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,$3,$4,$5)",
    [trip, credentials.a.id, plan.title, request, plan],
  );
  await q(
    "INSERT INTO trip_versions(trip_id,version,plan,reason) VALUES($1,1,$2,'ui-fixture')",
    [trip, plan],
  );
  await q(
    "INSERT INTO posts(id,user_id,title,body,tags,snapshot) VALUES($1,$2,$3,$4,$5,$6)",
    [
      post,
      credentials.b.id,
      "UI外滩慢慢走",
      "从外滩走到南京东路。\n\n这是一条测试路线，欢迎一起聊聊。",
      ["CityWalk", "上海"],
      plan,
    ],
  );
  await q(
    "INSERT INTO citywalks(id,user_id,title,city,stops,distance_m,verified_route) VALUES($1,$2,$3,$4,$5,1250,$6)",
    [
      walk,
      credentials.a.id,
      "UI上海步行路线",
      {
        id: "shanghai",
        name: "上海",
        country: "CN",
        lat: 31.2304,
        lng: 121.4737,
      },
      JSON.stringify(stops),
      {
        status: 'verified', distanceM: 1250, warning: false, blocked: false,
        provider: 'ui-fixture',
        legs: [{fromId: stops[0].id, toId: stops[1].id, distanceM: 1250,
          paths: [[[stops[0].lng,stops[0].lat],[stops[1].lng,stops[1].lat]]]}],
      },
    ],
  );
  const controlToken = randomBytes(24).toString("hex");
  const {refreshItem}=await appImport('server/recommendation/profiles.mjs');
  await refreshItem({query:q},post);
  const testState = { ...credentials, trip, post, walk, controlToken };
  await writeFile(path.join(runtime, "state.json"), JSON.stringify(testState), {
    mode: 0o600,
  });
  const { createFrontend } = await appImport("server/frontend.mjs");
  const app = createFrontend({ backendOrigin: "http://127.0.0.1:19887" });
  let nativeReady = false;
  front = http
    .createServer((req, res) => {
      if (req.url === "/frontend-health" && !nativeReady) {
        res.writeHead(503);
        res.end("Regression setup running");
        return;
      }
      if (req.url === "/__ui_test/stop" && req.method === "POST") {
        if (req.headers["x-test-control"] !== controlToken) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        setTimeout(() => void stop(), 100);
        return;
      }
      app(req, res);
    })
    .listen(19888, "127.0.0.1");
  await new Promise((resolve, reject) => {
    front.once("listening", resolve);
    front.once("error", reject);
  });
  await mkdir(path.join(appRoot, ".runtime"), { recursive: true });
  await writeFile(
    path.join(appRoot, ".runtime/ui-test-state.json"),
    JSON.stringify(testState),
    { mode: 0o600 },
  );
  await runNative({ appRoot, root, password,dbPort });
  nativeReady = true;
  console.log(
    "UI regression ready: isolated PostgreSQL, real app, no paid providers.",
  );
} catch (e) {
  console.error(
    "UI harness failed:",
    e?.name,
    e?.message,
    e?.code,
    e?.errors?.map((x) => ({ code: x.code, address: x.address, port: x.port })),
  );
  await Promise.race([
    stopDatabase().catch(() => {}),
    new Promise((r) => setTimeout(r, 20000)),
  ]);
  process.exit(1);
}
