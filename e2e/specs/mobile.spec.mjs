/* 验证移动端页面交互。 */

import { test, expect, signIn } from "../fixtures.mjs";
import { check } from "../cases.mjs";
check(
  "E2E-009",
  async ({ page, context, fixture }) => {
    await signIn(context, fixture);
    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 840 });
      for (const route of ["home", "profile", "account", "agent"]) {
        await page.goto("/#/" + route);
        await expect(page.locator("body")).not.toHaveClass(/auth-pending/);
        await expect(
          page.locator(
            route === "home"
              ? "#begin"
              : route === "profile"
                ? "#profile-page"
                : "#detail-page",
          ),
        ).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          width + " " + route + " horizontal overflow",
        ).toBe(true);
      }
    }
  },
  "partial",
  "Chromium触屏视口360/390/430的溢出与入口；非鸿蒙原生/键盘/所有页面验收",
);
