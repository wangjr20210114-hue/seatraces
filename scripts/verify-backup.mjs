/* 在独立数据库中恢复备份并核对业务数据。 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(path.join(root, ".runtime/local.json"), "utf8"));
const connection = { host: "127.0.0.1", port: config.port, user: "seatraces", password: config.password };
const tables = ["users", "sessions", "places", "trips", "trip_versions", "posts", "reactions", "comments", "browse_events", "api_usage", "import_jobs", "audit_log"];
const checksum = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function readRows(client, table) {
  return (await client.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM "${table}" t`)).rows[0].rows;
}
const source = new pg.Client({ ...connection, database: "seatraces" });
const admin = new pg.Client({ ...connection, database: "postgres" });
const temporaryName = "seatraces_restore_" + randomBytes(8).toString("hex");
let restored, created = false;
try {
  await source.connect();
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const backup = { format: "seatraces-local-rows-v1", createdAt: new Date().toISOString(), tables: {} };
  for (const table of tables) backup.tables[table] = await readRows(source, table);
  await source.query("COMMIT");
  const directory = path.join(root, ".runtime/backups");
  await mkdir(directory, { recursive: true });
  const filename = "rows-" + backup.createdAt.replace(/[:.]/g, "-") + ".json";
  await writeFile(path.join(directory, filename), JSON.stringify(backup), { mode: 0o600 });
  const saved = JSON.parse(await readFile(path.join(directory, filename), "utf8"));
  await admin.connect();
  await admin.query(`CREATE DATABASE "${temporaryName}"`);
  created = true;
  restored = new pg.Client({ ...connection, database: temporaryName });
  await restored.connect();
  await restored.query(await readFile(path.join(root, "server/schema.sql"), "utf8"));
  await restored.query("BEGIN");
  for (const table of tables) {
    await restored.query(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_recordset(NULL::"${table}",$1::jsonb)`, [JSON.stringify(saved.tables[table])]);
  }
  for (const table of ["api_usage", "audit_log"]) {
    await restored.query(`SELECT setval(pg_get_serial_sequence('${table}','id'),greatest(coalesce(max(id),1),1),max(id) IS NOT NULL) FROM "${table}"`);
  }
  await restored.query("COMMIT");
  const report = [];
  for (const table of tables) {
    const rows = await readRows(restored, table);
    assert.equal(checksum(rows), checksum(backup.tables[table]), `${table}: restored contents differ`);
    report.push({ table, rows: rows.length, checksum: "matched" });
  }
  console.log(JSON.stringify({ verified: true, tables: report, backup: ".runtime/backups/" + filename, note: "Application rows and schema restored into a new local database; not a pg_dump, PostGIS or production disaster-recovery test." }, null, 2));
} finally {
  await source.end().catch(() => {});
  if (restored) await restored.end().catch(() => {});
  if (created) await admin.query(`DROP DATABASE "${temporaryName}"`);
  await admin.end().catch(() => {});
}
