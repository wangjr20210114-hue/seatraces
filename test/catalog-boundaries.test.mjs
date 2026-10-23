/* 验证地点目录的边界条件。 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { iterationFixture } from "./helpers/iteration-db.mjs";
import { installDraftRoutes } from "../server/social/drafts.mjs";
import { installCommunityInteractions } from "../server/services/community-interactions.mjs";
import { installInboxRoutes } from "../server/operations/inbox.mjs";
import { composeSuggestion } from "../server/social/writing.mjs";

const enabled = process.env.TEST_CATALOG === "1";
const schemas = [
  "schema.sql",
  "citywalk-schema.sql",
  "discovery-schema.sql",
  "social/schema.sql",
];
const run = (name, fn) => test(name, { skip: !enabled, timeout: 60000 }, fn);
const state = async () =>
  JSON.parse(
    await readFile(
      new URL("../.runtime/ui-test-state.json", import.meta.url),
      "utf8",
    ),
  );
const origin = "http://127.0.0.1:19888";
async function api(url, body, method, role = "a") {
  const s = await state(),
    u = s[role];
  const r = await fetch(origin + url, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      "X-Seatraces": "1",
      Cookie:
        "st_session=" +
        u.token +
        (u.adminToken ? "; st_admin=" + u.adminToken : ""),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
async function browserCheck(fn, { role = "a", ...options } = {}) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.UI_BROWSER ? { channel: process.env.UI_BROWSER } : {}),
  });
  let page;
  try {
    const context = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
      ...options,
    });
    await context.route("**/*", (route) =>
      ["127.0.0.1", "localhost"].includes(
        new URL(route.request().url()).hostname,
      )
        ? route.continue()
        : route.abort(),
    );
    const s = await state();
    if (role) {
      await context.addCookies([
        { name: "st_session", value: s[role].token, url: origin },
        ...(role === "admin"
          ? [{ name: "st_admin", value: s.admin.adminToken, url: origin }]
          : []),
      ]);
    }
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    await fn(page, context, s);
  } catch (error) {
    if (page && process.env.CATALOG_OUTPUT_PATH) {
      const dir = path.join(
        process.env.CATALOG_OUTPUT_PATH,
        "native-artifacts",
      );
      await mkdir(dir, { recursive: true });
      const screenshot = path.join(dir, randomUUID() + ".png");
      await page
        .screenshot({ path: screenshot, fullPage: true })
        .catch(() => {});
      error.message += "\nBrowser evidence: " + screenshot;
    }
    throw error;
  } finally {
    await browser.close();
  }
}

run(
  "AUTH boundary: account, password bytes, nickname and email reject malformed values",
  async () => {
    const f = await iterationFixture();
    try {
      await f.start();
      for (const username of ["ab", "a".repeat(33), "空格", "a b"])
        assert.equal(
          (
            await f.request("/api/auth/register", {
              user: null,
              body: { username, password: "Valid-test-123" },
            })
          ).status,
          400,
        );
      for (const password of ["1234567", "中".repeat(25)])
        assert.equal(
          (
            await f.request("/api/auth/register", {
              user: null,
              body: { username: "boundary_user", password },
            })
          ).status,
          400,
        );
      for (const username of ["abc", "a".repeat(32)]) {
        const r = await f.request("/api/auth/register", {
          user: null,
          body: { username, password: "x".repeat(72), role: "admin" },
        });
        assert.equal(r.status, 200);
        assert.equal(r.data.user.role, "user");
      }
      assert.equal(
        (
          await f.request("/api/auth/email/request", {
            user: "user",
            body: { email: "not-an-email", currentPassword: f.password },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await f.request("/api/me", {
            user: "user",
            method: "PATCH",
            body: { nickname: "x".repeat(41) },
          })
        ).status,
        400,
      );
    } finally {
      await f.close();
    }
  },
);
run("AUTH redirect: external next cannot leave the application", async () =>
  browserCheck(async (page) => {
    await page.goto(
      "/login.html?next=" + encodeURIComponent("https://example.invalid/steal"),
    );
    await expect(page).toHaveURL(origin + "/");
  }),
);

run(
  "TRIP mutation: versions, locked stops, invalid candidates and restore",
  async () => {
    const s = await state(),
      url = "/api/trips/" + s.trip;
    let original = (await api(url)).data,
      version = original.version;
    const patch = (b) => api(url, { version, ...b }, "PATCH");
    let r = await patch({
      operation: { type: "lock", day: 0, placeId: "ui-bund" },
    });
    assert.equal(r.status, 200);
    version = r.data.version;
    assert.equal(
      (
        await patch({
          operation: { type: "remove", day: 0, placeId: "ui-bund" },
        })
      ).status,
      409,
    );
    assert.equal(
      (await api(url, { version: version - 1, status: "completed" }, "PATCH"))
        .status,
      409,
    );
    r = await patch({ restoreVersion: original.version });
    assert.equal(r.status, 200);
    version = r.data.version;
    assert.deepEqual(r.data.plan, original.plan);
    assert.equal(
      (
        await patch({
          operation: {
            type: "replace",
            day: 0,
            placeId: "ui-bund",
            newPlaceId: "foreign-unknown",
          },
        })
      ).status,
      400,
    );
    r = await patch({
      operation: { type: "move", day: 0, placeId: "ui-bund", to: 1 },
    });
    assert.equal(r.status, 200);
    version = r.data.version;
    assert.equal(r.data.plan.days[0].stops[1].id, "ui-bund");
    r = await patch({
      operation: { type: "remove", day: 0, placeId: "ui-street" },
    });
    assert.equal(r.status, 200);
    version = r.data.version;
    assert.ok(!r.data.plan.days[0].stops.some((p) => p.id === "ui-street"));
    r = await patch({ restoreVersion: original.version });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.plan, original.plan);
    assert.equal((await api(url, undefined, undefined, "b")).status, 404);
  },
);
run(
  "WALK limits: selected-stop and title boundaries precede provider calls",
  async () => {
    const base = {
      id: randomUUID(),
      draftId: randomUUID(),
      title: "测试步行",
      clusterIds: ["unknown"],
      startId: "p0",
      stopIds: ["p0", "p1"],
    };
    for (const n of [0, 1, 101])
      assert.equal(
        (
          await api("/api/citywalks", {
            ...base,
            stopIds: Array.from({ length: n }, (_, i) => "p" + i),
          })
        ).status,
        400,
      );
    assert.equal(
      (
        await api("/api/citywalks", {
          ...base,
          stopIds: Array.from({ length: 100 }, (_, i) => "p" + i),
        })
      ).status,
      410,
    );
    for (const title of ["", "长".repeat(101)])
      assert.equal(
        (await api("/api/citywalks", { ...base, title })).status,
        400,
      );
  },
);

run(
  "SOC reactions: concurrent idempotent likes, saves and recommendations",
  async () => {
    const f = await iterationFixture({ schemas });
    try {
      installCommunityInteractions(f.app, f);
      await f.start();
      const id = randomUUID();
      await f.query(
        "INSERT INTO posts(id,user_id,title,body,snapshot) VALUES($1,$2,'测试','测试','{}')",
        [id, f.users.other.id],
      );
      for (const kind of ["like", "save", "recommend"]) {
        const rows = await Promise.all(
          Array.from({ length: 8 }, () =>
            f.request("/api/posts/" + id + "/reactions", {
              user: "user",
              body: { kind, active: true },
            }),
          ),
        );
        assert.ok(rows.every((r) => r.status === 200));
      }
      assert.equal(
        Number(
          (
            await f.query("SELECT count(*) n FROM reactions WHERE post_id=$1", [
              id,
            ])
          ).rows[0].n,
        ),
        3,
      );
      await f.request("/api/posts/" + id + "/reactions", {
        user: "user",
        body: { kind: "like", active: false },
      });
      assert.equal(
        Number(
          (
            await f.query("SELECT count(*) n FROM reactions WHERE post_id=$1", [
              id,
            ])
          ).rows[0].n,
        ),
        2,
      );
    } finally {
      await f.close();
    }
  },
);
run("SOC comments: blank, 500 and 501 character boundaries", async () => {
  const s = await state(),
    url = "/api/posts/" + s.post + "/comments";
  assert.equal((await api(url, { body: "   " })).status, 400);
  assert.equal((await api(url, { body: "字".repeat(501) })).status, 400);
  assert.equal((await api(url, { body: "字".repeat(500) })).status, 200);
  assert.ok((await api(url)).data.some((c) => c.body.length === 500));
});
run(
  "POST boundaries: limits, ownership and quota use real PostgreSQL transactions",
  async () => {
    const f = await iterationFixture({ schemas });
    try {
      installDraftRoutes(f.app, f);
      await f.start();
      const id = randomUUID();
      const call = (p, body, method) =>
        f.request(p, { user: "user", body, method });
      assert.equal((await call("/api/social/drafts", { id })).status, 200);
      let b = {
        version: 1,
        title: "字".repeat(100),
        body: "文".repeat(4000),
        tags: Array.from({ length: 8 }, (_, i) => String(i) + "字".repeat(19)),
        mediaIds: [],
      };
      assert.equal(
        (await call("/api/social/drafts/" + id, b, "PUT")).status,
        200,
      );
      b.version = 2;
      for (const change of [
        { title: "字".repeat(101) },
        { body: "文".repeat(4001) },
        { tags: Array.from({ length: 9 }, (_, i) => String(i)) },
        { tags: ["字".repeat(21)] },
        { mediaIds: Array.from({ length: 10 }, randomUUID) },
        { mediaIds: [randomUUID()] },
        { user_id: f.users.other.id },
      ])
        assert.equal(
          (await call("/api/social/drafts/" + id, { ...b, ...change }, "PUT"))
            .status,
          400,
        );
      await f.query(
        "INSERT INTO post_drafts(id,user_id) SELECT gen_random_uuid(),$1 FROM generate_series(1,99)",
        [f.users.user.id],
      );
      assert.equal(
        (await call("/api/social/drafts", { id: randomUUID() })).status,
        409,
      );
      assert.equal((await call("/api/social/drafts", { id })).status, 200);
      assert.equal(
        Number((await f.query("SELECT count(*) n FROM post_drafts")).rows[0].n),
        100,
      );
    } finally {
      await f.close();
    }
  },
);
run(
  "POST writing: supplied facts only; absent route cannot invent an experience",
  () => {
    assert.throws(() =>
      composeSuggestion(
        { snapshot: {} },
        { tone: "lively", highlightIds: ["fiction"], ending: "save" },
      ),
    );
    const r = composeSuggestion(
      { snapshot: { days: [{ city: "上海", stops: [{ name: "外滩" }] }] } },
      { tone: "concise", highlightIds: ["day-0"], ending: "save" },
    );
    assert.match(r.body, /外滩/);
    assert.doesNotMatch(r.body, /亲测|免费|人均|已经去过/);
  },
);
run(
  "OPS cancel: cancellation is repeatable and sent campaigns are protected",
  async () => {
    const f = await iterationFixture({
      schemas: ["operations/inbox-schema.sql"],
    });
    try {
      installInboxRoutes(f.app, f);
      await f.start();
      const id = randomUUID(),
        body = {
          id,
          title: "取消测试",
          body: "测试",
          audience: "all",
          recipientIds: [],
        };
      assert.equal(
        (await f.request("/api/admin/messages", { body })).status,
        201,
      );
      const first = await f.request("/api/admin/messages/" + id + "/cancel", {
        body: {},
      });
      const second = await f.request("/api/admin/messages/" + id + "/cancel", {
        body: {},
      });
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(first.data.version, second.data.version);
      await f.query("UPDATE inbox_campaigns SET status='sent' WHERE id=$1", [
        id,
      ]);
      assert.equal(
        (await f.request("/api/admin/messages/" + id + "/cancel", { body: {} }))
          .status,
        409,
      );
      assert.equal(
        (
          await f.request("/api/admin/messages/" + id, {
            body: { ...body, version: first.data.version },
            method: "PUT",
          })
        ).status,
        409,
      );
    } finally {
      await f.close();
    }
  },
);
run(
  "DATA transport: unconfigured providers return no fabricated departures",
  async () => {
    for (const type of ["train", "flight"]) {
      const r = await api("/api/transport", {
        type,
        from: "北京",
        to: "上海",
        date: "2027-06-01",
      });
      assert.equal(r.status, 200);
      assert.match(
        JSON.stringify(r.data),
        /unavailable|not_configured|未配置|暂未|未接入/,
      );
      assert.ok(!r.data.items?.length && !r.data.results?.length);
    }
  },
);
run(
  "DATA import: guest/user denial and invalid payload do not write data",
  async () => {
    assert.equal((await api("/api/admin/places/import", [])).status, 403);
    for (const body of [
      [],
      [{ unrecognized: "bad" }],
      Array.from({ length: 501 }, () => ({ id: "bad" })),
    ])
      assert.equal(
        (await api("/api/admin/places/import", body, "POST", "admin")).status,
        400,
      );
  },
);

run(
  "WALK home: classic cards open and carousel pause is accessible",
  async () =>
    browserCheck(async (page) => {
      await page.goto("/");
      await expect(
        page.locator("#classic-walks [data-classic]").first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "暂停自动轮播" }).click();
      await expect(
        page.getByRole("button", { name: "开启自动轮播" }),
      ).toBeVisible();
      await page.locator("#classic-walks [data-classic]").first().click();
      await expect(page).toHaveURL(/#\/citywalk\/classic/);
    }),
);
run(
  "SOC share: copied URL contains only the public post identifier",
  async () =>
    browserCheck(async (page, context, s) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "share", { value: undefined });
        Object.defineProperty(navigator, "clipboard", {
          value: {
            writeText: async (text) => {
              window.__shared = text;
            },
          },
        });
      });
      await page.goto("/#/post/" + s.post);
      await page.locator("[data-share]").click();
      await expect
        .poll(() => page.evaluate(() => window.__shared))
        .toBe(origin + "/#/post/" + s.post);
    }),
);
run(
  "POST offline: failed save preserves text and reconnect permits retry",
  async () =>
    browserCheck(async (page, context) => {
      const id = randomUUID();
      assert.equal((await api("/api/social/drafts", { id })).status, 200);
      await page.goto("/#/compose/" + id);
      await page.locator("#post-title").fill("断网仍保留我的标题");
      await page.locator("#post-body").fill("不可丢失的正文");
      await context.setOffline(true);
      await page.locator("[data-save]").click();
      await expect(
        page.locator(".social-composer > [role=status]"),
      ).toContainText(/连不上|失败|网络|连接/);
      await expect(page.locator("#post-body")).toHaveValue("不可丢失的正文");
      await context.setOffline(false);
      await page.locator("[data-save]").click();
      await expect(
        page.locator(".social-composer > [role=status]"),
      ).toContainText("草稿已保存");
      assert.equal(
        (await api("/api/social/drafts/" + id)).data.body,
        "不可丢失的正文",
      );
    }),
);
run(
  "AI entry: dragging stays in viewport and keyboard can open the agent",
  async () =>
    browserCheck(
      async (page) => {
        await page.goto("/");
        const button = page.locator('button[title^="问 AI"]');
        await expect(button).toBeVisible();
        const r = await button.boundingBox();
        await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
        await page.mouse.down();
        await page.mouse.move(1, 1, { steps: 8 });
        await page.mouse.up();
        const moved = await button.boundingBox();
        assert.ok(moved.x >= 0 && moved.y >= 0);
        assert.ok(moved.x + moved.width <= 1280);
        await button.focus();
        await page.keyboard.press("Alt+ArrowRight");
        await page.waitForTimeout(360);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/#\/agent/);
      },
      { reducedMotion: "reduce" },
    ),
);
run(
  "ADM navigation: user detail reload and return preserve an accessible page",
  async () =>
    browserCheck(
      async (page, context, s) => {
        await page.goto("/admin.html#/users/" + s.a.id);
        await expect(page.locator("#back-users")).toBeVisible();
        await page.reload();
        await expect(page.locator(".user-heading")).toContainText("ui_a");
        await page.locator("#back-users").click();
        await expect(page.locator("#user-filter")).toBeVisible();
      },
      { role: "admin" },
    ),
);
run(
  "LOG controls: submitted filters, column choice, reload and reset",
  async () =>
    browserCheck(
      async (page) => {
        await page.goto("/admin.html#/events");
        await page.locator("#log-filter [name=actor]").fill("ui_admin");
        await page.locator("#log-filter button[type=submit]").click();
        await expect(page).toHaveURL(/actor=ui_admin/);
        await page.locator(".log-column-settings summary").click();
        const c = page.locator('[data-column="request_id"]');
        await c.check();
        await expect(page).toHaveURL(/request_id/);
        await page.reload();
        await expect(page.locator("#log-filter [name=actor]")).toHaveValue(
          "ui_admin",
        );
        await page.locator("#log-reset").click();
        await expect(page.locator("#log-filter [name=actor]")).toHaveValue("");
      },
      { role: "admin" },
    ),
);
run(
  "E2E desktop: desktop and tablet home have no horizontal page overflow",
  async () =>
    browserCheck(async (page) => {
      for (const width of [1280, 768]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/");
        await expect(page.locator("#begin")).toBeVisible();
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
      }
    }),
);
run(
  "E2E selection latency: twenty local selections, p95 below 200ms",
  async (t) =>
    browserCheck(async (page) => {
      await page.goto("/#/citywalk/new");
      await page.locator("#walk-city-query").fill("上海");
      await page
        .locator("#walk-city-options [data-city]")
        .filter({ hasText: "上海" })
        .first()
        .click();
      await page.locator("[data-area]").first().click();
      await expect(
        page.locator("#walk-candidates [data-place]").first(),
      ).toBeVisible();
      const times = await page.evaluate(async () => {
        const times = [];
        for (let i = 0; i < 20; i++) {
          const b = document.querySelector(
            i % 2
              ? "#walk-selected [data-remove]"
              : "#walk-candidates [data-place]",
          );
          if (!b) throw Error("Selection control missing");
          const start = performance.now();
          b.click();
          await new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          );
          times.push(performance.now() - start);
        }
        return times;
      });
      const sorted = times.toSorted((a, b) => a - b),
        p95 = sorted[18];
      t.diagnostic(
        JSON.stringify({
          samples: 20,
          p95Ms: p95,
          scope: "small fixture, local click handler + 2 frames",
        }),
      );
      assert.ok(p95 < 200, "p95=" + p95);
    }),
);
run(
  "E2E list latency: twenty local private list reads have p95 below 2s",
  async (t) => {
    const times = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      assert.equal((await api("/api/trips")).status, 200);
      times.push(performance.now() - start);
    }
    const p95 = times.toSorted((a, b) => a - b)[18];
    t.diagnostic(JSON.stringify({ samples: 20, p95Ms: p95 }));
    assert.ok(p95 < 2000);
  },
);
run(
  "E2E isolation: disposable endpoints and synthetic users only",
  async () => {
    const cfg = JSON.parse(
      await readFile(process.env.ITERATION_DB_CONFIG, "utf8"),
    );
    assert.equal(cfg.port, Number(process.env.UI_DB_PORT||55439));
    assert.ok(![54329,19887,19888].includes(cfg.port));
    assert.match(process.env.ITERATION_DB_CONFIG, /reports[\\/]ui[\\/]app-/);
    const s = await state();
    assert.equal(s.a.username, "ui_a");
    assert.equal(s.b.username, "ui_b");
    assert.equal(s.admin.username, "ui_admin");
    assert.equal((await api("/api/me")).data.user.username, "ui_a");
  },
);
