/* 启动本地 PostgreSQL 与业务服务，管理开发进程。 */

import EmbeddedPostgres from "embedded-postgres";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pgDriver from "pg";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
await mkdir(".runtime", { recursive: true });
let config;
try {
  config = JSON.parse(await readFile(".runtime/local.json", "utf8"));
} catch {
  config = { password: randomBytes(24).toString("hex"), port: 54329 };
  await writeFile(".runtime/local.json", JSON.stringify(config), {
    mode: 0o600,
  });
}
const db = new EmbeddedPostgres({
  databaseDir: path.join(root, ".runtime/pg"),
  user: "seatraces",
  password: config.password,
  port: config.port,
  persistent: true,
  authMethod: "scram-sha-256",
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: [
    "-c",
    "listen_addresses=127.0.0.1",
    "-c",
    "shared_buffers=64MB",
    "-c",
    "max_connections=30",
  ],
  onLog: () => {},
  onError: (m) => {
    if (String(m).includes("FATAL")) console.error(String(m));
  },
});
if (!existsSync(".runtime/pg/PG_VERSION")) await db.initialise();
let existing = false;
const probe = new pgDriver.Client({
  host: "127.0.0.1",
  port: config.port,
  user: "seatraces",
  password: config.password,
  database: "postgres",
  connectionTimeoutMillis: 2000,
});
try {
  await probe.connect();
  await probe.query("SELECT 1");
  existing = true;
} catch {
} finally {
  await probe.end().catch(() => {});
}
if (!existing) await db.start();
const client = db.getPgClient();
await client.connect();
if (
  !(await client.query("SELECT 1 FROM pg_database WHERE datname='seatraces'"))
    .rowCount
)
  await client.query("CREATE DATABASE seatraces");
await client.end();
process.env.DATABASE_URL = `postgresql://seatraces:${config.password}@127.0.0.1:${config.port}/seatraces`;
process.env.NODE_ENV = "development";
console.log("Local PostgreSQL ready on 127.0.0.1:" + config.port);
await import("../server/index.mjs");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await db.stop();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
