import { test, expect, signIn, loginUI, get } from "../fixtures.mjs";
import { check } from "../cases.mjs";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

check("ADM-001", async ({ page }) => {
  await page.goto("/admin.html");
  await expect(page).toHaveURL(/admin-login/);
  const r = await page.request.get("/api/admin/users");
  expect(r.status()).toBe(401);
  expect(await r.text()).not.toContain("ui_admin");
});
check("ADM-002", async ({ page, context, fixture }) => {
  for (const role of ["a", "admin"]) {
    await signIn(context, fixture, role);
    await page.goto("/admin.html");
    await expect(page).toHaveURL(/admin-login/);
    expect((await page.request.get("/api/admin/users")).status()).toBe(
      role === "a" ? 403 : 401,
    );
  }
});
check("ADM-003", async ({ page, fixture }) => {
  await page.goto("/admin-login.html");
  await page.locator("[name=username]").fill("ui_admin");
  await page.locator("[name=password]").fill("invalid-password");
  await page.locator("#admin-sign-in").click();
  await expect(page).toHaveURL(/admin-login/);
  await expect(page.getByRole("alert")).not.toBeEmpty();
  await loginUI(page, fixture, "admin", true);
  for (const section of [
    "overview",
    "analytics",
    "users",
    "journeys",
    "quality",
    "agent",
    "events",
    "content",
    "messages",
    "classics",
    "tasks",
    "access",
  ]) {
    await page.locator("[data-section=" + section + "]").click();
    await expect(page.locator("#admin-content")).not.toBeEmpty();
    await expect(page.locator("#admin-status")).toBeEmpty();
    await expect(page).toHaveURL(new RegExp("#/" + section));
  }
});
check("ADM-004", async ({ page, context, fixture }) => {
  await signIn(context, fixture);
  await loginUI(page, fixture, "admin", true);
  await page.locator("#admin-logout").click();
  await expect(page).toHaveURL(/admin-login/);
  await page.goto("/admin.html");
  await expect(page).toHaveURL(/admin-login/);
  expect((await get(page, "/api/me")).user.username).toBe("ui_a");
});

test.describe("后台业务", () => {
  test.beforeEach(async ({ context, fixture }) =>
    signIn(context, fixture, "admin", true),
  );
  check(
    "ADM-013",
    async ({ page }) => {
      await page.goto("/admin.html#/users");
      await page.locator("#user-filter [name=q]").fill("ui_a");
      await page.locator("#user-filter [name=role]").selectOption("user");
      await page.locator("#user-filter button").click();
      await expect(page.locator("tbody")).toContainText("ui_a");
      await expect(page.locator("tbody")).not.toContainText("ui_admin");
      await page.locator("#user-filter [name=q]").fill("不存在xyz");
      await page.locator("#user-filter button").click();
      await expect(page.locator("tbody")).toContainText("暂无记录");
    },
    "partial",
    "组合查询与空状态；敏感字段和所有筛选组合另有接口/人工用例",
  );
  check("ADM-019", async ({ page, fixture }) => {
    await page.goto("/admin.html#/users");
    await expect(
      page.locator('[data-user="' + fixture.admin.id + '"]').first(),
    ).toBeDisabled();
    const r = await page.request.patch(
      "/api/admin/users/" + fixture.admin.id + "/status",
      {
        headers: { "X-Seatraces": "1" },
        data: { disabled: true, reason: "ui test" },
      },
    );
    expect([400, 403, 409]).toContain(r.status());
  });
  check(
    "LOG-001",
    async ({ page }) => {
      await page.goto("/admin.html#/events");
      await page.locator("#log-filter [name=actor]").fill("ui_admin");
      await page.locator("#log-filter [name=action]").fill("ui_no_such_action");
      await page.locator("#log-filter button[type=submit]").click();
      await expect(page.locator("#log-results")).toContainText(
        "没有符合条件的日志",
      );
      await page.locator("#log-reset").click();
      await expect(page.locator("#log-filter [name=actor]")).toHaveValue("");
    },
    "partial",
    "覆盖组合空查询及重置；具体事件类型与耗时排序由其他用例验收",
  );
  check(
    "LOG-018",
    async ({ page }, info) => {
      await page.goto("/admin.html#/events");
      await page.locator("#log-export-start").click();
      await expect(page.locator("[data-download]").first()).toBeVisible({
        timeout: 25000,
      });
      const pending = page.waitForEvent("download");
      await page.locator("[data-download]").first().click();
      const download = await pending;
      const raw = gunzipSync(await readFile(await download.path())).toString(
        "utf8",
      );
      const rows = raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s));
      expect(rows.length).toBeGreaterThan(0);
      expect(raw).not.toMatch(/password_hash|st_session|st_admin|Bearer /);
      await info.attach("export-check", {
        body: JSON.stringify({ rows: rows.length, gzip: true }),
        contentType: "application/json",
      });
    },
    "partial",
    "真实异步任务与压缩包解析；特定筛选快照一致性另有接口用例",
  );
  check("OPS-001", async ({ page, context, fixture }) => {
    const title = "UI未发送草稿 " + Date.now();
    await messageDraft(page, title);
    await expect(page.locator("#admin-content")).toContainText("待发送");
    await expect(page.locator("#admin-content")).toContainText("ui_a");
    await signIn(context, fixture);
    expect(
      (await get(page, "/api/me/messages")).items.some(
        (x) => x.title === title,
      ),
    ).toBe(false);
  });
  check("OPS-005", async ({ page, context, fixture }) => {
    const title = "UI定向消息 " + Date.now();
    await messageDraft(page, title);
    await page.locator("#send-message").click();
    await expect(page.locator("#admin-content")).toContainText("已发送");
    await signIn(context, fixture);
    await page.goto("/#/messages");
    await page.getByRole("button", { name: new RegExp(title) }).click();
    await expect(page.locator(".inbox-letter")).toContainText(
      "只在隔离测试库中发送",
    );
    await expect
      .poll(async () => {
        const r = await get(page, "/api/me/messages");
        return !!r.items.find((x) => x.title === title)?.read_at;
      })
      .toBe(true);
    await signIn(context, fixture, "b");
    expect(
      (await get(page, "/api/me/messages")).items.some(
        (x) => x.title === title,
      ),
    ).toBe(false);
  });
});
async function messageDraft(page, title) {
  await page.goto("/admin.html#/messages");
  await page.locator("#new-message").click();
  await page.locator("#message-form [name=title]").fill(title);
  await page.locator("#message-form [name=body]").fill("只在隔离测试库中发送");
  await page.locator("#recipient-query").fill("ui_a");
  await page.locator("#recipient-search").click();
  await page
    .locator("#recipient-list label")
    .filter({ hasText: /ui_a\b/ })
    .first()
    .getByRole("checkbox")
    .check();
  await page.getByRole("button", { name: "保存并预览", exact: true }).click();
  await expect(page.locator("#send-message")).toBeVisible();
}
