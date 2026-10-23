/* 验证外部服务请求边界。 */

import test from "node:test";
import assert from "node:assert/strict";
import { createJsonRequester } from "../server/integrations/http.mjs";
import { createAmapClient } from "../server/integrations/amap.mjs";
import { createDeepseekClient } from "../server/integrations/deepseek.mjs";
import { createOsmClient } from "../server/integrations/osm.mjs";
import { createCatalogService } from "../server/services/catalog.mjs";

test("named-place recall can prefer relevance while nearby browsing keeps distance ordering", async () => {
  for (const version of ["v3", "v5"]) {
    const seen = [];
    const client = createAmapClient({
      env: { AMAP_KEY: "FAKE", AMAP_POI_VERSION: version },
      requestJSON: async (provider, url) => {
        const sort = new URL(url).searchParams.get("sortrule");
        seen.push(sort);
        return {
          status: "1",
          pois:
            sort === "weight"
              ? [{ name: "样本景点" }]
              : [{ name: "样本景点小卖部" }],
        };
      },
    });
    const query = { keywords: "样本景点", location: "120.1,31.1", limit: 5 };
    assert.equal(
      (await client.searchAround(query)).pois[0].name,
      "样本景点小卖部",
    );
    assert.equal(
      (await client.searchAround({ ...query, sort: "weight" })).pois[0].name,
      "样本景点",
    );
    await assert.rejects(
      client.searchAround({ ...query, sort: "invalid" }),
      (e) => e.status === 400,
    );
    assert.deepEqual(seen, ["distance", "weight"]);
  }
});

test("budget refusal precedes every network operation and retains its status", async () => {
  let calls = 0;
  const request = createJsonRequester({
    reserve: async () => {
      throw Object.assign(Error("budget"), { status: 429 });
    },
    fetchImpl: async () => {
      calls++;
    },
  });
  await assert.rejects(
    request("Amap", "https://example.invalid"),
    (e) => e.status === 429,
  );
  assert.equal(calls, 0);
});
test("provider failures never reveal URLs, keys or request bodies and do not retry", async () => {
  let calls = 0;
  const request = createJsonRequester({
    reserve: async () => {},
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(options.redirect, "error");
      assert.ok(options.signal);
      throw Error(url + " SECRET");
    },
  });
  await assert.rejects(
    request("Amap", "https://example.invalid?key=SECRET"),
    (e) =>
      e.status === 502 &&
      !e.message.includes("SECRET") &&
      !e.message.includes("https"),
  );
  assert.equal(calls, 1);
});
test("DeepSeek receives only bounded JSON work and missing key makes no request", async () => {
  let calls = 0;
  const llm = createDeepseekClient({
    env: { DEEPSEEK_API_KEY: "FAKE_TEST_ONLY" },
    requestJSON: async (provider, url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.response_format.type, "json_object");
      assert.equal(body.max_tokens, 900);
      assert.equal(
        body.messages[1].content,
        JSON.stringify({ value: "supplied fact" }),
      );
      assert.equal(body.tools, undefined);
      assert.equal(body.thinking.type, "disabled");
      return {
        choices: [
          {
            finish_reason: "stop",
            message: { content: '{"value":"supplied fact"}' },
          },
        ],
      };
    },
  });
  assert.deepEqual(
    await llm("Return supplied value", { value: "supplied fact" }),
    { value: "supplied fact" },
  );
  const absent = createDeepseekClient({
    env: {},
    requestJSON: async () => {
      calls++;
    },
  });
  await assert.rejects(absent("x", {}), (e) => e.status === 503);
  assert.equal(calls, 1);
});
test("truncated, malformed, scalar and array model responses cannot become objects", async () => {
  for (const [content, finish_reason] of [
    ["{}", "length"],
    ["broken", "stop"],
    ["null", "stop"],
    ["[]", "stop"],
    ["42", "stop"],
  ]) {
    const llm = createDeepseekClient({
      env: { DEEPSEEK_API_KEY: "FAKE" },
      requestJSON: async () => ({
        choices: [{ message: { content }, finish_reason }],
      }),
    });
    await assert.rejects(llm("x", {}), (e) => e.status === 502);
  }
});
test("Amap uses the configured POI version without automatic fallback or persisting results", async () => {
  for (const version of ["v3", "v5"]) {
    const seen = [];
    const client = createAmapClient({
      env: { AMAP_KEY: "FAKE", AMAP_POI_VERSION: version },
      requestJSON: async (provider, url) => {
        seen.push(new URL(url));
        return { status: "1", pois: [] };
      },
    });
    await client.searchText({ keywords: "园林", city: "苏州", limit: 2 });
    await client.searchAround({
      keywords: "园林",
      location: "120.1,31.1",
      limit: 3,
    });
    assert.equal(seen[0].pathname, `/${version}/place/text`);
    assert.equal(seen[1].pathname, `/${version}/place/around`);
    assert.equal(
      seen[0].searchParams.get(version === "v5" ? "page_size" : "offset"),
      "2",
    );
    assert.equal(
      seen[0].searchParams.get(version === "v5" ? "region" : "city"),
      "苏州",
    );
    assert.equal(seen.length, 2);
  }
});
test("Amap cannot forward arbitrary paths or override the configured key", async () => {
  let calls = 0;
  const client = createAmapClient({
    env: { AMAP_KEY: "CONFIGURED_TEST_ONLY" },
    requestJSON: async (provider, url) => {
      calls++;
      assert.equal(
        new URL(url).searchParams.get("key"),
        "CONFIGURED_TEST_ONLY",
      );
      return { status: "0", infocode: "10001", info: "SECRET" };
    },
  });
  await assert.rejects(
    client.call("https://evil.invalid"),
    (e) => e.status === 400,
  );
  await assert.rejects(
    client.call("v3/place/text", { key: "OVERRIDE" }),
    (e) => e.providerCode === "10001" && !e.message.includes("SECRET"),
  );
  assert.equal(calls, 1);
});
test("OSM transport preserves client errors and only calls supported read endpoints", async () => {
  let calls = 0;
  const request = createOsmClient({
    env: { OSM_SERVICE_URL: "http://127.0.0.1:8791" },
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url.pathname, "/places");
      assert.equal(url.searchParams.get("q"), "园林");
      assert.equal(options.redirect, "error");
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "private SQL details" }),
      };
    },
  });
  await assert.rejects(
    request("/places", { q: "园林" }),
    (e) => e.status === 400 && !e.message.includes("SQL"),
  );
  await assert.rejects(request("/admin"), (e) => e.status === 400);
  assert.equal(calls, 1);
});
test("catalog orchestration preserves live data and clearly marks snapshot fallback", async () => {
  const payload = { status: "live", items: [{ id: "osm:node/1" }] };
  let saved;
  const service = createCatalogService({
    env: { OSM_SERVICE_URL: "configured" },
    requestSource: async () => payload,
    remember: (path, params, data) => {
      saved = data;
    },
  });
  assert.equal(await service.catalogRequest("/places", {}), payload);
  assert.equal(saved, payload);
  const fallback = createCatalogService({
    env: { OSM_SERVICE_URL: "configured" },
    requestSource: async () => {
      throw Error("offline");
    },
    cached: () => ({ at: "2026-10-11T00:00:00Z", payload }),
  });
  const result = await fallback.catalogRequest("/places", {});
  assert.equal(result.status, "snapshot");
  assert.equal(result.scope, "cached_query_only");
  assert.equal(result.elapsedMs, null);
});
test("catalog invalid queries never fall back, and absent configuration remains explicit", async () => {
  const service = createCatalogService({
    env: { OSM_SERVICE_URL: "configured" },
    requestSource: async () => {
      throw Object.assign(Error("bad"), { status: 400 });
    },
    cached: () => {
      throw Error("must not read");
    },
  });
  await assert.rejects(
    service.catalogRequest("/places"),
    (e) => e.status === 400,
  );
  const absent = createCatalogService({
    env: {},
    requestSource: async () => {
      throw Error("must not call");
    },
  });
  assert.equal(
    (await absent.catalogRequest("/places")).status,
    "not_configured",
  );
});
test("resolving a place keeps cloud provenance and uses the local repository only for local IDs", async () => {
  const seen = [];
  const service = createCatalogService({
    env: { OSM_SERVICE_URL: "configured" },
    requestSource: async (path, params) => {
      seen.push(params.id);
      return { status: "live", item: { id: params.id } };
    },
    remember: () => {},
    findLocal: async (id) => ({ id, source: "local" }),
  });
  assert.equal((await service.resolvePlace("osm:node/1")).cacheStatus, "live");
  assert.equal((await service.resolvePlace("seed:1")).source, "local");
  assert.deepEqual(seen, ["osm:node/1"]);
});
