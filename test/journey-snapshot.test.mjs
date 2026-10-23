/* 验证城市选择快照读取。 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import express from "express";
import { journeyFixture } from "./helpers/journey-db.mjs";
import { withSavedCityRows } from "../server/repositories/journey-snapshot.mjs";
import { sendSavedCitySelection } from "../server/services/journey-recovery-stream.mjs";
import { restoredCitySelection } from "../server/services/journey-service.mjs";
import { scenicSummary } from "../server/domain/scenic-summary.mjs";

test("large city questionnaires recover without changing stored choices", {
  skip: process.env.TEST_OPERATIONS !== "1", timeout: 120000,
}, async (t) => {
  const f = await journeyFixture(), sessionId = randomUUID(), userId = f.users.user.id;
  const city = { id: "beijing", name: "北京" };
  const options = { transaction: f.transaction, sessionId, userId, cityId: city.id };
  const boundaryOffline = async () => { throw Error("offline"); };
  const put = (snapshot) => f.query("UPDATE journey_sessions SET catalog=$2 WHERE id=$1",
    [sessionId, JSON.stringify(snapshot ? { beijing: snapshot } : {})]);
  const read = (extra = {}) => withSavedCityRows({ ...options, ...extra }, async (header, rows) => {
    const result = { ...header, clusters: [] };
    for await (const row of rows) {
      if (row.kind === "group") result.clusters.push({ ...row.data, members: [] });
      else result.clusters.at(-1).members.push(row.data);
    }
    return result;
  });
  let server;
  try {
    await f.query("INSERT INTO journey_sessions(id,user_id,request) VALUES($1,$2,$3)",
      [sessionId, userId, JSON.stringify({ cities: [city] })]);
    await t.test("selecting a city without an existing catalog still uses normal preparation", async () => {
      assert.equal(await withSavedCityRows(options, () => assert.fail("no snapshot")), false);
    });
    const snapshot = { snapshotFormat: "scenic-summary/1", inventory: { clusterCount: 13, placeCount: 4800 },
      clusters: Array.from({ length: 12 }, (_, g) => ({
        id: `original-area-${g}`, number: g + 1, name: `片区${g}`, memberCount: 400,
        members: Array.from({ length: 400 }, (_, p) => ({
          id: `${g}-${p}`, name: `地点${g}-${p}`, lat: 39.9, lng: 116.4,
          facts: { text: "北京地点说明".repeat(145) },
          children: p === 0 ? [{ id: `child-${g}`, possibleDuplicateIds: [`alias-${g}`] }] : [],
          sourceRecords: [{ id: `source-${g}-${p}`, raw: "legacy-provenance".repeat(100) }],
        })),
      })),
    };
    snapshot.clusters.push({ id: "empty-area", members: [] });
    await put(snapshot);
    const before = (await f.query("SELECT md5(catalog::text) hash,octet_length(catalog::text) bytes FROM journey_sessions WHERE id=$1", [sessionId])).rows[0];
    assert.ok(before.bytes > 8 * 1024 * 1024);
    const wishes = {};
    const app = express();
    let lastRequestDone;
    app.post("/city", async (_req, res) => {
      lastRequestDone = sendSavedCitySelection({ ...options, res, wishes,
        restoreHeader: header => restoredCitySelection({ ...header, clusters: [] }, city, wishes, boundaryOffline),
      });
      const found = await lastRequestDone;
      if (!found) res.status(404).json({ error: "missing" });
    });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/city`;
    await t.test("only Beijing selected, no places selected: full HTTP JSON exceeds 8 MB and succeeds", async () => {
      const started = performance.now(), response = await fetch(url, { method: "POST" });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const text = await response.text();
      assert.ok(Buffer.byteLength(text) > 8 * 1024 * 1024);
      const data = JSON.parse(text);
      assert.deepEqual(data.clusters.map(g => g.id), snapshot.clusters.map(g => g.id));
      assert.equal(data.clusters.flatMap(g => g.members).length, 4800);
      assert.equal(data.clusters[12].members.length, 0);
      assert.equal(data.boundary.status, "unavailable");
      assert.equal(data.clusters[0].members[0].wanted, false);
      assert.equal(data.clusters[11].members[399].id, "11-399");
      assert.deepEqual(data.clusters[0].members[0].sourceRecords, [{ id: "source-0-0" }]);
      t.diagnostic(JSON.stringify({ savedBytes: before.bytes, responseBytes: Buffer.byteLength(text), milliseconds: Math.round(performance.now() - started) }));
    });
    await t.test("resume keeps parent/child alias wishes, order, metadata and every stored record", async () => {
      wishes["alias-0"] = true;
      wishes["1-1"] = true;
      wishes["2-2"] = false;
      const data = await (await fetch(url, { method: "POST" })).json();
      assert.equal(data.clusters[0].members[0].wanted, true);
      assert.equal(data.clusters[0].members[0].children[0].wanted, true);
      assert.equal(data.clusters[1].members[1].ownWanted, true);
      assert.equal(data.clusters[2].members[2].wanted, false);
      assert.deepEqual(data.inventory, snapshot.inventory);
      for (let g = 0; g < 12; g++) assert.deepEqual(data.clusters[g].members.map(p => p.id), snapshot.clusters[g].members.map(p => p.id));
      assert.equal((await f.query("SELECT md5(catalog::text) hash FROM journey_sessions WHERE id=$1", [sessionId])).rows[0].hash, before.hash);
    });
    await t.test("a different owner or city cannot read a saved snapshot", async () => {
      assert.equal(await read({ userId: f.users.other.id }), false);
      assert.equal(await read({ cityId: "shanghai" }), false);
    });
    await t.test("closing the client mid-response releases the cursor and leaves saved data intact", async () => {
      const controller = new AbortController();
      const response = await fetch(url, { method: "POST", signal: controller.signal });
      const reader = response.body.getReader();
      await reader.read();
      controller.abort();
      await lastRequestDone;
      assert.equal((await f.query("SELECT md5(catalog::text) hash FROM journey_sessions WHERE id=$1", [sessionId])).rows[0].hash, before.hash);
    });
    await t.test("a 192 MB process streams the large snapshot without retaining it", async () => {
      const child = spawn(process.execPath, ["--max-old-space-size=192", "test/helpers/journey-snapshot-worker.mjs", f.schema, sessionId, userId], { windowsHide: true });
      let out = "", err = "";
      child.stdout.on("data", b => out += b);
      child.stderr.on("data", b => err += b);
      const [code] = await once(child, "close");
      assert.equal(code, 0, err);
      const result = JSON.parse(out);
      assert.equal(result.places, 4800);
      assert.ok(result.peakHeapMB < 150);
      t.diagnostic(out.trim());
    });
    await t.test("a concurrent catalog update cannot mix old and new groups", async () => {
      let count = 0;
      await withSavedCityRows(options, async (_header, rows) => {
        await put({ clusters: [{ id: "replacement", members: [] }] });
        for await (const row of rows) if (row.kind === "place") count++;
      });
      assert.equal(count, 4800);
    });
    await t.test("legacy children retain IDs while raw provenance is omitted", async () => {
      const p = { id: "old", children: [{ id: "nested", parentId: "old", sourceRecords: [{ id: "alias", raw: "x".repeat(9000000) }] }] };
      await put({ clusters: [{ id: "legacy", members: [p] }] });
      await withSavedCityRows(options, async (_header, rows) => {
        for await (const row of rows) if (row.kind === "place") assert.deepEqual(row.data, scenicSummary(p));
      });
    });
    await t.test("individual malformed huge records remain bounded and a failed read releases its transaction", async () => {
      await put({ clusters: [{ id: "bad", members: [{ id: "huge", opening_hours: "x".repeat(9000000) }] }] });
      await assert.rejects(read(), { status: 413 });
      await put({ clusters: [] });
      assert.equal(await read(), true);
      await assert.rejects(withSavedCityRows(options, () => { throw Error("client closed"); }), /client closed/);
      assert.equal(await read(), true);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await f.close();
  }
});
