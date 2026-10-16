import { createReadJobs } from "../server/services/read-jobs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createCatalogCache } from "../server/repositories/catalog-cache.mjs";
import { boundedJsonBytes } from "../server/repositories/bounded-json.mjs";
const file = new URL("file:///fake/cache.json");
test("cache bytes are bounded before serialization and oversized responses remain unchanged", async () => {
  const written = [];
  const io = {
    stat: async () => ({ size: 30 * 1024 * 1024 }),
    readFile: async () => {
      throw Error("oversized legacy cache must not be read");
    },
    mkdir: async () => {},
    writeFile: async (_, v) => written.push(v),
    rename: async () => {},
  };
  const cache = await createCatalogCache({
    file,
    io,
    maxBytes: 4096,
    maxEntryBytes: 512,
    maxEntries: 20,
  });
  const large = {
    items: Array.from({ length: 5043 }, (_, i) => ({
      id: i,
      data: "字".repeat(1000),
    })),
  };
  cache.remember("/cluster-places", {}, large);
  assert.equal(large.items.length, 5043);
  assert.equal(cache.get("/cluster-places", {}), null);
  for (let i = 0; i < 1000; i++)
    cache.remember(
      "/place",
      { id: i },
      { item: { id: i, name: "测试".repeat(40) } },
    );
  await cache.flush();
  assert.ok(cache.stats().bytes <= 4096);
  assert.ok(cache.stats().entries <= 20);
  assert.equal(written.length, 1);
  assert.ok(Buffer.byteLength(written[0]) <= 4096);
  assert.ok(cache.get("/place", { id: 999 }));
  assert.equal(cache.get("/place", { id: 0 }), null);
});
test("slow snapshot writer coalesces 200 refreshes instead of retaining queued full copies", async () => {
  let release, started;
  const began = new Promise((r) => (started = r)),
    pause = new Promise((r) => (release = r));
  const writes = [];
  const io = {
    stat: async () => {
      throw Error();
    },
    mkdir: async () => {},
    writeFile: async (_, v) => {
      writes.push(v);
      if (writes.length === 1) {
        started();
        await pause;
      }
    },
    rename: async () => {},
  };
  const cache = await createCatalogCache({
    file,
    io,
    maxBytes: 8192,
    maxEntryBytes: 1024,
  });
  cache.remember("/place", { id: 1 }, { item: { id: 1 } });
  await began;
  for (let i = 0; i < 200; i++)
    cache.remember("/place", { id: 1 }, { item: { id: 1, revision: i } });
  assert.equal(cache.stats().pendingWrites, 1);
  assert.equal(writes.length, 1);
  release();
  await cache.flush();
  assert.equal(writes.length, 2);
  assert.equal(
    Object.values(JSON.parse(writes[1]))[0].payload.item.revision,
    199,
  );
});
test("snapshot recovery, expiry and disk errors do not break successful catalog reads", async () => {
  let data,
    clock = Date.now();
  const io = {
    stat: async () => ({ size: data?.length || 0 }),
    readFile: async () => data || "{}",
    mkdir: async () => {},
    writeFile: async (_, v) => {
      data = v;
    },
    rename: async () => {},
  };
  let cache = await createCatalogCache({ file, io, now: () => clock });
  cache.remember(
    "/places",
    { a: 1, b: undefined },
    { items: [{ id: "one", name: "一" }] },
  );
  await cache.flush();
  cache = await createCatalogCache({ file, io, now: () => clock });
  assert.equal(cache.get("/place", { id: "one" }).payload.item.name, "一");
  assert.ok(cache.get("/places", { a: 1 }));
  clock += 8 * 86400000;
  assert.equal(cache.get("/place", { id: "one" }), null);
  io.writeFile = async () => {
    throw Error("read-only disk");
  };
  cache.remember("/place", { id: "two" }, { item: { id: "two" } });
  await cache.flush();
  assert.ok(cache.get("/place", { id: "two" }));
});
test("byte accounting includes escaped unicode, nesting and rejects cycles safely", () => {
  const value = { a: '\n"\\中文', b: [true, null, 3, { z: "ok" }] };
  assert.equal(
    boundedJsonBytes(value, 1000),
    Buffer.byteLength(JSON.stringify(value)),
  );
  assert.equal(boundedJsonBytes(value, 3), Infinity);
  const c = {};
  c.c = c;
  assert.equal(boundedJsonBytes(c, 1000), Infinity);
});

test("delivered city results expire promptly; uncollected jobs also release without new requests", async () => {
  let clock = 1000,
    calls = 0;
  const jobs = createReadJobs({
    now: () => clock,
    ttlMs: 100,
    deliveredTtlMs: 10,
  });
  const work = async () => ({ call: ++calls });
  assert.equal(jobs("city", work).status, "loading");
  await new Promise((r) => setImmediate(r));
  assert.equal(jobs("city", work).call, 1);
  clock += 5;
  assert.equal(jobs("city", work).call, 1);
  clock += 6;
  assert.equal(jobs("city", work).status, "loading");
  await new Promise((r) => setImmediate(r));
  assert.equal(jobs("city", work).call, 2);
  const timed = createReadJobs({ ttlMs: 10 });
  timed("discarded", work);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(timed("discarded", work).status, "loading");
});
