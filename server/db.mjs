import pg from "pg";
import { readFile } from "node:fs/promises";
import {requestContext,applyRequestContext,trackedMutation} from './operations/request-context.mjs';
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});
// An idle connection can disappear during local PostgreSQL restart. Never let
// EventEmitter dump the pg Client (which contains connection credentials).
pool.on("error", (error) =>
  console.error(
    "Database connection unavailable (" +
      (/^[A-Z0-9_]+$/.test(error.code || "") ? error.code : "connection_lost") +
      ")",
  ),
);
export const query = (sql, values) => requestContext()&&trackedMutation(sql)
  ? transaction(c=>c.query(sql,values)) : pool.query(sql, values);
export async function transaction(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await applyRequestContext(c);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function migrate() {
  await query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  await transaction(async (c) =>
    c.query(
      await readFile(new URL("./auth-schema.sql", import.meta.url), "utf8"),
    ),
  );
  await transaction(async (c) =>
    c.query(
      await readFile(new URL("./citywalk-schema.sql", import.meta.url), "utf8"),
    ),
  );
  await transaction(async (c) =>
    c.query(await readFile(new URL("./discovery-schema.sql", import.meta.url), "utf8")),
  );
  await transaction(async (c) =>
    c.query(
      await readFile(
        new URL("./trip-services-schema.sql", import.meta.url),
        "utf8",
      ),
    ),
  );
  await transaction(async (c) =>
    c.query(
      await readFile(
        new URL("./service-prices-schema.sql", import.meta.url),
        "utf8",
      ),
    ),
  );
  await transaction(async (c) =>
    c.query(await readFile(new URL('./agent/schema.sql', import.meta.url), 'utf8')),
  );
  await transaction(async c => c.query(await readFile(new URL('./operations/schema.sql', import.meta.url), 'utf8')));
  await transaction(async c => c.query(await readFile(new URL('./operations/access-schema.sql', import.meta.url), 'utf8')));
  await transaction(async c => c.query(await readFile(new URL('./operations/inbox-schema.sql', import.meta.url), 'utf8')));
  await transaction(async c => c.query(await readFile(new URL('./citywalk-expansion-schema.sql', import.meta.url), 'utf8')));
  await transaction(async c => c.query(await readFile(new URL('./operations/product-schema.sql', import.meta.url), 'utf8')));
  await transaction(async c => c.query(await readFile(new URL('./operations/analytics-schema.sql', import.meta.url), 'utf8')));
  await transaction(async c => c.query(await readFile(new URL('./operations/moderation-schema.sql', import.meta.url), 'utf8')));
  await transaction(async c => c.query(await readFile(new URL('./operations/maintenance-schema.sql', import.meta.url), 'utf8')));
}
export async function savePlace(p, c = pool) {
  const search = [p.name, ...(p.aliases || []), p.city, p.province].join(" ");
  await c.query(
    `INSERT INTO places(id,name,aliases,category,country,province,city,lat,lng,timezone,tags,description,duration_min,hours,cost,currency,source,license,source_url,verified_at,data_status,search_text)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
 ON CONFLICT(id) DO UPDATE SET name=excluded.name,aliases=excluded.aliases,category=excluded.category,country=excluded.country,province=excluded.province,city=excluded.city,lat=excluded.lat,lng=excluded.lng,timezone=excluded.timezone,tags=excluded.tags,description=excluded.description,duration_min=excluded.duration_min,hours=excluded.hours,cost=excluded.cost,currency=excluded.currency,source=excluded.source,license=excluded.license,source_url=excluded.source_url,verified_at=excluded.verified_at,data_status=excluded.data_status,search_text=excluded.search_text,updated_at=now()`,
    [
      p.id,
      p.name,
      p.aliases || [],
      p.category,
      p.country,
      p.province || "",
      p.city,
      p.lat,
      p.lng,
      p.timezone || "Asia/Shanghai",
      p.tags || [],
      p.description || "",
      p.duration_min ?? 90,
      p.hours ? JSON.stringify(p.hours) : null,
      p.cost ?? 0,
      p.currency || "CNY",
      p.source,
      p.license,
      p.source_url || "",
      p.verified_at || null,
      p.data_status || "demo",
      search,
    ],
  );
}
