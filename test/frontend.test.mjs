import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createFrontend } from "../server/frontend.mjs";

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test("frontend survives backend loss; API failure is explicit and static files stay available", async t => {
  const backend = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); });
  const origin = await listen(backend);
  const frontend = http.createServer(createFrontend({ backendOrigin: origin }));
  const base = await listen(frontend);
  t.after(async () => { await close(frontend); if (backend.listening) await close(backend); });
  assert.equal((await (await fetch(base + "/api/health")).json()).ok, true);
  await close(backend);
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const id of ["home", "discover-page", "profile-page", "connection-status"]) assert.ok(html.includes(`id="${id}"`));
  for (const file of ["journey.js", "journey.css", "amap-view.html", "amap-view.js"]) assert.equal((await fetch(base + "/" + file)).status, 200);
  assert.equal((await (await fetch(base + "/frontend-health")).json()).service, "seatraces-frontend");
  const api = await fetch(base + "/api/health");
  assert.equal(api.status, 503);
  assert.equal((await api.json()).code, "backend_unavailable");
  for (const file of [".env", "server/schema.sql", "archive/legacy-ui/app.js"]) assert.equal((await fetch(base + "/" + file)).status, 404);
  const old = await fetch(base + "/legacy.html", { redirect: "manual" });
  assert.equal(old.status, 302);
  assert.equal(old.headers.get("location"), "/");
});

test("same-origin API proxy preserves request body and session cookies", async t => {
  const backend = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.setHeader("content-type", "application/json");
    res.setHeader("set-cookie", "st_session=test-only; HttpOnly; SameSite=Strict; Path=/");
    res.end(JSON.stringify({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString(), cookie: req.headers.cookie, marker: req.headers["x-seatraces"] }));
  });
  const frontend = http.createServer(createFrontend({ backendOrigin: await listen(backend) }));
  const base = await listen(frontend);
  t.after(async () => { await close(frontend); await close(backend); });
  const response = await fetch(base + "/api/example?city=beijing", { method: "POST", headers: { "Content-Type": "application/json", "X-Seatraces": "1", Cookie: "st_session=test-only" }, body: '{"a":1}' });
  assert.deepEqual(await response.json(), { path: "/api/example?city=beijing", method: "POST", body: '{"a":1}', cookie: "st_session=test-only", marker: "1" });
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.equal((await fetch(base + "/not-an-api")).status, 404);
});
