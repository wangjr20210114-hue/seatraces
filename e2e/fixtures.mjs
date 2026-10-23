/* 准备界面测试会话，封装登录和接口访问。 */

import { test as base, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
export { expect };
export const test = base.extend({
  fixture: async ({}, use) =>
    use(
      JSON.parse(
        await readFile(
          new URL("../.runtime/ui-test/state.json", import.meta.url),
          "utf8",
        ),
      ),
    ),
  page: async ({ page, context }, use, testInfo) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      return ["127.0.0.1", "localhost"].includes(u.hostname) ||
        ["data:", "blob:"].includes(u.protocol)
        ? route.continue()
        : route.abort("blockedbyclient");
    });
    await page.addInitScript(() => {
      window.__uiMapMessages = [];
      window.addEventListener("message", (e) => {
        if (
          e.origin === location.origin &&
          /^seatraces-/.test(e.data?.type || "")
        )
          window.__uiMapMessages.push(e.data);
      });
    });
    await use(page);
    if (errors.length) {
      await testInfo.attach("browser-errors", {
        body: JSON.stringify(errors, null, 2),
        contentType: "application/json",
      });
      expect(errors, "Unexpected browser errors").toEqual([]);
    }
  },
});
export async function signIn(context, fixture, role = "a", admin = false) {
  const u = fixture[role];
  await context.addCookies([
    {
      name: admin ? "st_admin" : "st_session",
      value: admin ? u.adminToken : u.token,
      url: "http://127.0.0.1:19888",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}
export async function home(page) {
  await page.goto("/#/home");
  await expect(page.locator("body")).not.toHaveClass(/auth-pending/);
}
export async function get(page, url) {
  const r = await page.request.get(url);
  expect(r.ok(), url).toBeTruthy();
  return r.json();
}
export async function write(page, url, data, method = "POST") {
  const r = await page.request.fetch(url, {
    method,
    data,
    headers: { "X-Seatraces": "1" },
  });
  expect(r.ok(), url + " " + (await r.text())).toBeTruthy();
  return r.json();
}
export async function loginUI(page, fixture, role = "a", admin = false) {
  await page.goto(admin ? "/admin-login.html" : "/login.html");
  for (let attempt = 0; attempt < 14; attempt++) {
    await page.locator("input[name=username]").fill(fixture[role].username);
    await page.locator("input[name=password]").fill(fixture.password);
    const reply = page.waitForResponse(
      (r) =>
        r.url().endsWith(admin ? "/api/auth/admin/login" : "/api/auth/login") &&
        r.request().method() === "POST",
    );
    await page.locator(admin ? "#admin-sign-in" : "#submit-login").click();
    const r = await reply;
    if (r.status() !== 429) {
      expect(r.ok(), "Login returned HTTP " + r.status()).toBe(true);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  await expect(page).toHaveURL(admin ? /\/admin.html/ : /#\/home/);
  if (admin) {
    await expect(page.locator("#admin-name")).not.toBeEmpty();
    await expect(page.locator("#admin-status")).toBeEmpty();
  }
}
