/* 缓存地点目录，管理有效期和快照读取。 */

import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { boundedJsonBytes } from "./bounded-json.mjs";
const TTL = 7 * 86400000;
const cacheKey = (path, params) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        path,
        Object.entries(params)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)])
          .sort(),
      ]),
    )
    .digest("hex");

export async function createCatalogCache({
  file = new URL("../../.runtime/catalog-cache.json", import.meta.url),
  maxBytes = 8 * 1024 * 1024,
  maxEntryBytes = 1024 * 1024,
  maxEntries = 256,
  io = { readFile, writeFile, mkdir, rename, stat },
  now = Date.now,
} = {}) {
  const entries = new Map();
  let bytes = 2,
    dirty = false,
    saving = null;
  const remove = (key) => {
    const old = entries.get(key);
    if (old) {
      bytes -= old.bytes;
      entries.delete(key);
    }
  };
  function put(key, saved) {
    const size = boundedJsonBytes(saved, maxEntryBytes);
    remove(key);
    if (!Number.isFinite(size) || size + 68 > maxBytes) return;
    entries.set(key, { saved, bytes: size + 68 });
    bytes += size + 68;
    while (entries.size > maxEntries || bytes > maxBytes)
      remove(entries.keys().next().value);
  }
  function prune() {
    for (const [key, { saved }] of entries)
      if (!(now() - Date.parse(saved.at) < TTL)) remove(key);
  }
  try {
    if ((await io.stat(file)).size <= maxBytes) {
      const old = JSON.parse(await io.readFile(file, "utf8"));
      for (const [key, saved] of Object.entries(old))
        if (saved && now() - Date.parse(saved.at) < TTL) put(key, saved);
    }
  } catch {}
  function schedule() {
    dirty = true;
    if (saving) return;
    let failed = false;
    saving = Promise.resolve()
      .then(async () => {
        await io.mkdir(new URL(".", file), { recursive: true });
        while (dirty) {
          dirty = false;
          prune();
          const content = JSON.stringify(
            Object.fromEntries([...entries].map(([k, v]) => [k, v.saved])),
          );
          const temporary = new URL(file.href + ".tmp");
          await io.writeFile(temporary, content);
          await io.rename(temporary, file);
        }
      })
      .catch(() => {
        failed = true;
      })
      .finally(() => {
        saving = null;
        if (dirty && !failed) schedule();
      });
  }
  return {
    remember(path, params, payload) {
      prune();
      const at = new Date(now()).toISOString();
      put(cacheKey(path, params), { at, payload });
      if (path === "/places")
        for (const item of payload.items || [])
          put(cacheKey("/place", { id: item.id }), {
            at,
            payload: { status: "live", item },
          });
      schedule();
    },
    get(path, params) {
      const key = cacheKey(path, params);
      const found = entries.get(key);
      if (!found) return null;
      if (!(now() - Date.parse(found.saved.at) < TTL)) {
        remove(key);
        return null;
      }
      return found.saved;
    },
    async flush() {
      while (saving) await saving;
    },
    stats() {
      return { bytes, entries: entries.size, pendingWrites: saving ? 1 : 0 };
    },
  };
}
const snapshots = await createCatalogCache();
export const rememberCatalog = (...args) => snapshots.remember(...args);
export const cachedCatalog = (...args) => snapshots.get(...args);
