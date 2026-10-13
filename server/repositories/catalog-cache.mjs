// OSM-only recovery snapshots. Never use this store for commercial map responses.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";

const cacheFile = new URL("../../.runtime/catalog-cache.json", import.meta.url);
let cache = {},
  saving = Promise.resolve();
try {
  cache = JSON.parse(await readFile(cacheFile, "utf8"));
} catch {}
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
export function rememberCatalog(path, params, payload) {
  const at = new Date().toISOString();
  cache[cacheKey(path, params)] = { at, payload };
  if (path === "/places")
    for (const item of payload.items || [])
      cache[cacheKey("/place", { id: item.id })] = {
        at,
        payload: { status: "live", item },
      };
  cache = Object.fromEntries(
    Object.entries(cache)
      .filter(([, v]) => Date.now() - Date.parse(v.at) < 7 * 86400000)
      .sort((a, b) => b[1].at.localeCompare(a[1].at))
      .slice(0, 256),
  );
  const content = JSON.stringify(cache);
  saving = saving
    .catch(() => {})
    .then(async () => {
      await mkdir(new URL("../../.runtime/", import.meta.url), {
        recursive: true,
      });
      const temporary = new URL(
        "../../.runtime/catalog-cache.json.tmp",
        import.meta.url,
      );
      await writeFile(temporary, content);
      await rename(temporary, cacheFile);
    });
  saving.catch(() => {}); // A cache write failure must not turn a successful query into failure.
}

export function cachedCatalog(path, params) {
  const saved = cache[cacheKey(path, params)];
  return saved && Date.now() - Date.parse(saved.at) < 7 * 86400000
    ? saved
    : null;
}
