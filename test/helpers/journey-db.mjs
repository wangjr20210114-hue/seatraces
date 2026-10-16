import pg from "pg";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
export async function journeyFixture() {
  const cfg = JSON.parse(
    await readFile(
      process.env.ITERATION_DB_CONFIG ||
        new URL("../../.runtime/local.json", import.meta.url),
      "utf8",
    ),
  );
  const schema = "iteration_" + randomBytes(8).toString("hex");
  const pool = new pg.Pool({
    host: "127.0.0.1",
    port: cfg.port,
    user: "seatraces",
    password: cfg.password,
    database: "seatraces",
    max: 3,
    options: "-c search_path=" + schema + ",public",
  });
  pool.on("error", () => {});
  const query = (...args) => pool.query(...args);
  let created = false;
  const transaction = async (fn) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  };
  const close = async () => {
    try {
      if (created) await query("DROP SCHEMA " + schema + " CASCADE");
    } finally {
      await pool.end();
    }
  };
  try {
    await query("CREATE SCHEMA " + schema);
    created = true;
    await query(
      await readFile(
        new URL("../../server/schema.sql", import.meta.url),
        "utf8",
      ),
    );
    const users = { user: { id: randomUUID() }, other: { id: randomUUID() } };
    for (const [name, u] of Object.entries(users))
      await query(
        "INSERT INTO users(id,username,password_hash,nickname) VALUES($1,$2,'unusable-fixture','Fixture')",
        [u.id, name],
      );
    return { schema, query, transaction, users, close };
  } catch (e) {
    await close();
    throw e;
  }
}
