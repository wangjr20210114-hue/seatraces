/* 验证账号注册、登录和资料管理。 */

import { test, expect, signIn, home, loginUI, get } from "../fixtures.mjs";
import { check } from "../cases.mjs";

check(
  "AUTH-001",
  async ({ page }) => {
    await page.goto("/login.html");
    await page.getByRole("link", { name: /先逛逛/ }).click();
    await expect(page.locator("#begin")).toBeVisible();
    await page.reload();
    await expect(
      page.locator("#classic-walks .walk-slide").first(),
    ).toBeVisible();
  },
  "partial",
  "验证游客首页和经典入口；真实地图及后台不留游客轨迹另验收",
);
check(
  "AUTH-002",
  async ({ page }) => {
    await home(page);
    await page.locator("#classic-walks button[data-classic]").first().click();
    await expect(page.locator("#detail-title")).toBeVisible();
    await expect(page).toHaveURL(/citywalk/);
    await expect(page.locator("iframe[title]").last()).toBeAttached();
  },
  "partial",
  "游客打开真实经典路线页面与地图容器；高德底图未启用",
);
check("AUTH-003", async ({ page }) => {
  await home(page);
  await page.locator("#begin").click();
  await expect(page).toHaveURL(/login.html/);
});
check("AUTH-004", async ({ page }) => {
  await home(page);
  await page.locator("[data-page=discover]").click();
  await expect(page).toHaveURL(/login.html/);
  await page.goto("/#/discover");
  await expect(page).toHaveURL(/login.html/);
});
check(
  "AUTH-005",
  async ({ page }) => {
    for (const p of ["profile", "agent", "citywalk/new"]) {
      await page.goto("/#/" + p);
      await expect(page).toHaveURL(/login.html/);
    }
  },
  "partial",
  "覆盖我的、AI、自建CityWalk；附近吃住直链另测",
);
check("AUTH-007", async ({ page }) => {
  await page.goto("/login.html");
  await page.locator("[data-mode=register]").click();
  const name = "ui_new_" + Date.now();
  await page.locator("[name=username]").fill(name);
  await page.locator("[name=password]").fill("Ui-register-1234");
  await page.locator("[name=confirm]").fill("Ui-register-1234");
  await page.locator("#submit-login").click();
  await expect(page).toHaveURL(/#\/home/);
  await page.reload();
  expect((await get(page, "/api/me")).user.username).toBe(name);
});
check("AUTH-010", async ({ page }) => {
  await page.goto("/login.html");
  await page.locator("[data-mode=register]").click();
  for (const bad of ["", "中文账号", "bad/name", "bad'name", "bad name"]) {
    await page.locator("[name=username]").fill(bad);
    expect(
      await page
        .locator("[name=username]")
        .evaluate((el) => el.checkValidity()),
    ).toBe(false);
  }
  await expect(page).toHaveURL(/login/);
});
check("AUTH-013", async ({ page, context, fixture }) => {
  await loginUI(page, fixture);
  await page.reload();
  expect((await get(page, "/api/me")).user.username).toBe("ui_a");
  const p = await context.newPage();
  await p.goto("/#/history");
  await expect(p.locator(".history-list")).toContainText("UI上海两日行程");
  await p.close();
});
check("AUTH-014", async ({ page, fixture }) => {
  await page.goto("/login.html");
  for (const name of ["ui_a", "ui_missing"]) {
    await page.locator("[name=username]").fill(name);
    await page.locator("[name=password]").fill("wrong-password-2026");
    await page.locator("#submit-login").click();
    await expect(page.locator("#login-error")).not.toBeEmpty();
  }
  await loginUI(page, fixture);
});
check("AUTH-017", async ({ page, fixture }) => {
  await loginUI(page, fixture);
  await page.goto("/#/account");
  await page.locator("#sign-out").click();
  await expect(page).toHaveURL(/login/);
  await page.goto("/#/history");
  await expect(page).toHaveURL(/login/);
});
check("AUTH-021", async ({ page }) => {
  await page.goto("/login.html");
  await page.locator("#forgot-password").click();
  await expect(page.locator("main")).toContainText(/未配置|未开放|暂未/);
  expect((await get(page, "/api/auth/config")).emailEnabled).toBe(false);
});
check("AUTH-029", async ({ page }) => {
  for (const old of ["/legacy.html", "/catalog.html"]) {
    await page.goto(old);
    await expect(page).toHaveURL(/#\/home/);
  }
});

test.describe("个人中心", () => {
  test.beforeEach(async ({ context, fixture }) => signIn(context, fixture));
  check("ME-002", async ({ page }) => {
    await page.goto("/#/account");
    await expect(page.getByLabel("账号，不可修改")).toContainText("ui_a");
    await expect(page.locator("input[name=username]")).toHaveCount(0);
  });
  check("ME-003", async ({ page }) => {
    await page.goto("/#/account");
    await page.getByLabel("昵称", { exact: true }).fill("UI资料保存验收");
    await page.getByRole("button", { name: "保存资料", exact: true }).click();
    await expect(page.locator("#profile-message")).toContainText(/保存|更新/);
    await page.reload();
    await expect(page.getByLabel("昵称", { exact: true })).toHaveValue(
      "UI资料保存验收",
    );
  });
  check("ME-005", async ({ page }) => {
    await page.goto("/#/account");
    await page.getByRole("button", { name: "头像 🌿", exact: true }).click();
    await page.getByRole("button", { name: "保存资料", exact: true }).click();
    await expect(page.locator("#profile-message")).not.toBeEmpty();
    await page.reload();
    await expect(page.locator("#avatar-preview")).toHaveText("🌿");
  });
  check("ME-009", async ({ page, fixture }) => {
    await page.goto("/#/history");
    await page.getByRole("link", { name: /UI上海两日行程/ }).click();
    await expect(page).toHaveURL(new RegExp(fixture.trip));
    await expect(page.locator("#page-content")).toContainText("外滩");
    await expect(page.locator("#page-content")).toContainText("南京东路");
  });
  check("ME-027", async ({ page }) => {
    await page.goto("/#/help");
    await expect(page.locator("#detail-title")).toContainText(/帮助|关于/);
    await expect(page.locator("#page-content")).not.toBeEmpty();
    await page.locator("#page-back").click();
    await expect(page).not.toHaveURL(/#\/help/);
  });
  check(
    "ME-028",
    async ({ page }) => {
      for (const route of ["account", "history", "favorites", "settings"]) {
        await page.goto("/#/" + route);
        await expect(page.locator("#detail-page")).toBeVisible();
        await expect(page.locator("dialog[open]")).toHaveCount(0);
      }
    },
    "partial",
    "覆盖账号、历史、收藏和设置的独立页面",
  );
});
