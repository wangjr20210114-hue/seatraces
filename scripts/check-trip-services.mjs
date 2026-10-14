// Local smoke only: disposable account and trip, cleaned even after failure.
import pg from "pg";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
const config = JSON.parse(await readFile(".runtime/local.json", "utf8"));
const db = new pg.Client({
  host: "127.0.0.1",
  port: config.port,
  user: "seatraces",
  password: config.password,
  database: "seatraces",
});
const base = "http://127.0.0.1:8792";
let cookie = "",
  user;
const api = async (path, body, method) => {
  const r = await fetch(base + path, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      "X-Seatraces": "1",
      Cookie: cookie,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  const data = await r.json();
  if (!r.ok) throw Error("HTTP " + r.status + " " + (data.error || ""));
  return data;
};
try {
  await db.connect();
  user = (
    await api("/api/auth/register", {
      username: "dining_" + randomBytes(5).toString("hex"),
      password: randomBytes(20).toString("hex"),
      nickname: "吃住验收",
    })
  ).user;
  const id = randomUUID(),
    stops = [
      {
        id: "osm:way/2089097",
        name: "故宫博物院",
        lat: 39.9163,
        lng: 116.3972,
        leave: "12:00",
        country: "CN",
        mainlandCityVerified: true,
      },
      {
        id: "test-local-anchor",
        name: "王府井周边",
        lat: 39.914,
        lng: 116.412,
        leave: "17:00",
        country: "CN",
        mainlandCityVerified: true,
      },
    ];
  const plan = {
    schemaVersion: "journey/2",
    cities: [{ id: "city-beijing", name: "北京", lat: 39.9, lng: 116.4 }],
    days: [{ city: "北京", cityId: "city-beijing", date: "2026-10-20", stops }],
  };
  await db.query(
    "INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,$3,$4,$5)",
    [
      id,
      user.id,
      "吃住接口验收",
      JSON.stringify({
        origin: { label: "上海" },
        start: "2026-10-20",
        end: "2026-10-20",
      }),
      JSON.stringify(plan),
    ],
  );
  await db.query(
    "INSERT INTO trip_versions(trip_id,version,plan,reason) VALUES($1,1,$2,$3)",
    [id, JSON.stringify(plan), "本机测试"],
  );
  const started = Date.now(),
    r = await api("/api/journey/trips/" + id + "/services/recommendations", {
      day: 0,
    });
  const report = {
    at: new Date().toISOString(),
    queryMs: Date.now() - started,
    slots: r.slots.map((s) => ({
      kind: s.kind,
      status: s.status,
      items: s.items.map((p) => ({
        name: p.name,
        distanceMeters: p.distanceMeters,
        category: p.classification.category,
      })),
    })),
  };
  if (r.slots.some((s) => s.status === "unavailable" || !s.items.length))
    throw Error("Live catalog is unavailable or contains no nearby results");
  const slot = r.slots[0],
    body = {
      version: r.version,
      recommendationId: slot.recommendationId,
      placeId: slot.items[0].id,
    };
  await api(
    "/api/journey/trips/" +
      id +
      "/services/" +
      encodeURIComponent(slot.id) +
      "/preview",
    body,
  );
  const saved = await api(
    "/api/journey/trips/" + id + "/services/" + encodeURIComponent(slot.id),
    body,
    "PUT",
  );
  const restored = await api("/api/trips/" + id);
  if (
    restored.plan.services[slot.id].candidate.id !== body.placeId ||
    saved.trip.version !== 2
  )
    throw Error("Saved selection mismatch");
  report.persisted = true;
  report.version = 2;
  const again = Date.now();
  const cached = await api(
    "/api/journey/trips/" + id + "/services/recommendations",
    { day: 0 },
  );
  report.cachedMs = Date.now() - again;
  report.cacheHit = cached.slots.every((s) => s.cached);
  await writeFile(
    "validation/trip-services-smoke.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  if (user) await db.query("DELETE FROM users WHERE id=$1", [user.id]);
  await db.end();
}
