/* 验证业务接口集成流程。 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
const base = process.env.TEST_URL || "http://127.0.0.1:8787";
function client() {
  let cookie = "";
  return async (path, body, method) => {
    const r = await fetch(base + "/api" + path, {
      method: method || (body ? "POST" : "GET"),
      headers: {
        "Content-Type": "application/json",
        "X-Seatraces": "1",
        Cookie: cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.headers.get("set-cookie"))
      cookie = r.headers.get("set-cookie").split(";")[0];
    return { status: r.status, body: await r.json() };
  };
}
test("full API workflow, ownership, concurrency, privacy, community and unavailable providers", async () => {
  const a = client(),
    b = client(),
    anon = client(),
    suffix = randomBytes(5).toString("hex");
  const reg = await a("/auth/register", {
    username: "test_" + suffix,
    password: randomBytes(16).toString("hex"),
    nickname: "自动测试旅行者",
  });
  assert.equal(reg.status, 200);
  assert.equal(
    (
      await b("/auth/register", {
        username: "test_b_" + suffix,
        password: randomBytes(16).toString("hex"),
      })
    ).status,
    200,
  );
  assert.equal((await anon("/trips")).status, 401);
  assert.equal((await a("/admin/places/import", [])).status, 403);
  const input = {
    origin: "上海",
    cityIds: ["suzhou", "hangzhou"],
    start: "2026-10-12",
    end: "2026-10-14",
    interests: ["园林"],
    pace: "balanced",
    transport: "fewTransfers",
  };
  assert.equal(
    (await a("/trips", { ...input, end: "2026-10-10" })).status,
    400,
  );
  const created = await a("/trips", input);
  assert.equal(created.status, 201);
  let t = created.body;
  assert.ok(t.plan.days[0].stops.length > 0);
  assert.equal((await b("/trips/" + t.id)).status, 404);
  assert.equal((await b("/posts")).body.filter(p => p.trip_id === t.id).length, 0,
    "saving a route must not publish it");
  assert.equal(
    (await b("/trips/" + t.id, { version: 1, status: "completed" }, "PATCH"))
      .status,
    404,
  );
  const pid = t.plan.days[0].stops[0].id;
  t = (
    await a(
      "/trips/" + t.id,
      { version: 1, operation: { type: "lock", day: 0, placeId: pid } },
      "PATCH",
    )
  ).body;
  assert.equal(
    (await a("/trips/" + t.id, { version: 1, status: "completed" }, "PATCH"))
      .status,
    409,
  );
  assert.equal(
    (
      await a(
        "/trips/" + t.id,
        {
          version: t.version,
          operation: { type: "remove", day: 0, placeId: pid },
        },
        "PATCH",
      )
    ).status,
    409,
  );
  const preview = (
    await a("/trips/" + t.id + "/assistant", { day: 0, text: "这一天轻松一点" })
  ).body;
  assert.equal(preview.status, "preview");
  assert.equal((await a("/trips/" + t.id)).body.version, t.version);
  t = (
    await a(
      "/trips/" + t.id,
      { version: t.version, operation: preview.operation },
      "PATCH",
    )
  ).body;
  t = (
    await a(
      "/trips/" + t.id,
      { version: t.version, restoreVersion: 1 },
      "PATCH",
    )
  ).body;
  assert.equal(t.plan.days[0].stops[0].locked, false);
  const post = (
    await a("/posts", {
      tripId: t.id,
      title: "自动测试 · 完整路线",
      body: "这是一条本机接口验收记录。",
    })
  ).body;
  assert.ok(post.id);
  const published = await a("/discovery/publish", {kind:"journey",id:t.id});
  assert.equal(published.status,200);
  assert.equal(published.body.id,post.id);
  assert.equal((await b("/posts")).body.filter(p => p.id===post.id).length,1);
  assert.ok((await a("/discovery/mine")).body.items.some(p => p.id===post.id && p.isOwn));
  assert.ok(!(await b("/discovery/mine")).body.items.some(p => p.id===post.id));
  assert.equal((await b("/discovery/publish", {kind:"journey",id:t.id})).status,404);

  assert.equal(post.snapshot.days[0].anchor, undefined);
  assert.equal(
    (await a("/posts", { tripId: t.id, title: "重复分享", body: "不应重复" }))
      .status,
    409,
  );
  assert.equal(
    (
      await b("/posts/" + post.id + "/reactions", {
        kind: "save",
        active: true,
      })
    ).status,
    200,
  );
  await b("/posts/" + post.id + "/reactions", { kind: "save", active: true });
  assert.equal((await a("/posts")).body.find((p) => p.id === post.id).saves, 1);
  await b("/posts/" + post.id + "/comments", {
    body: "测试评论 <script>alert(1)</script>",
  });
  assert.equal((await a("/posts/" + post.id + "/comments")).body.length, 1);
  assert.equal(
    (await a("/posts/" + post.id + "/view", { seconds: 50 })).body.recorded,
    true,
  );
  await a(
    "/me",
    {
      nickname: "自动测试旅行者",
      avatar: "🌊",
      preferences: {
        interests: ["自然"],
        pace: "relaxed",
      },
    },
    "PATCH",
  );
  await a("/posts/" + post.id + "/view", { seconds: 100 });
  await a("/posts/" + post.id + "/view", { seconds: 100 });
  assert.equal((await a("/me/history")).body[0].dwell_seconds, 120);
  await a(
    "/me",
    {
      nickname: "自动测试旅行者",
      avatar: "🌊",
      preferences: {
        interests: ["自然"],
        pace: "relaxed",
        analyticsConsent: false,
      },
    },
    "PATCH",
  );
  assert.equal((await a("/me/history")).body.length, 1);
  assert.equal((await a('/me')).body.user.preferences.analyticsConsent, undefined);
  await a('/me/history', undefined, 'DELETE');
  assert.equal((await a('/me/history')).body.length, 0);
  assert.equal((await a("/me/report")).body.completed, 0);
  t = (
    await a(
      "/trips/" + t.id,
      { version: t.version, status: "completed" },
      "PATCH",
    )
  ).body;
  assert.equal((await a("/me/report")).body.completed, 1);
  const status = (await a("/status")).body;
  const forgedSelection=await a('/routes',{from:'suzhou-1',to:'suzhou-2',fromMatchToken:'fabricated.proof'});
  assert.equal(forgedSelection.status,409);
  assert.match(forgedSelection.body.error,/重新匹配/);
  if (status.providers.train === "not_configured") {
    const result = (
      await a("/transport", {
        type: "train",
        from: "上海",
        to: "杭州",
        date: "2026-10-12",
      })
    ).body;
    assert.equal(result.status, "not_configured");
    assert.deepEqual(result.items, []);
  }
  if (status.providers.maps === "not_configured") {
    const r = (await a("/routes", { from: "suzhou-1", to: "suzhou-2" })).body;
    assert.equal(r.status, "estimated");
  }
  assert.equal(
    (await fetch(base + "/api/auth/logout", { method: "POST" })).status,
    403,
  );
  await a("/auth/logout", {});
  assert.equal((await a("/trips")).status, 401);
});
