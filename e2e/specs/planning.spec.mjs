import { test, expect, signIn, home } from "../fixtures.mjs";
import { check } from "../cases.mjs";
test.beforeEach(async ({ context, fixture }) => signIn(context, fixture));
async function destinations(page) {
  await home(page);
  await page.locator("#begin").click();
  await page.locator("#origin").fill("北京");
  await page.locator("#next").click();
  await expect(page.locator("#city-search")).toBeVisible();
}
async function city(page, name) {
  await page.locator("#city-search").fill(name);
  await page
    .locator("#city-results [data-city]")
    .filter({ hasText: name })
    .first()
    .click();
}
check("PLAN-004", async ({ page }) => {
  await destinations(page);
  for (const name of ["上海", "北京", "杭州", "苏州", "西安"])
    await city(page, name);
  await expect(page.locator("#selected-cities [data-remove]")).toHaveCount(5);
  await city(page, "成都");
  await expect(page.locator("#selected-cities [data-remove]")).toHaveCount(5);
  await expect(page.locator("#selected-cities")).not.toContainText("成都");
});
check("PLAN-005", async ({ page }) => {
  await destinations(page);
  await city(page, "上海");
  await expect(page.locator("#selected-cities [data-remove]")).toHaveCount(1);
  await city(page, "上海");
  await expect(page.locator("#selected-cities [data-remove]")).toHaveCount(0);
  await city(page, "上海");
  await page.locator("#selected-cities [data-remove]").click();
  await expect(page.locator("#selected-cities [data-remove]")).toHaveCount(0);
  await city(page, "杭州");
  await city(page, "上海");
  await expect(
    page.locator("#selected-cities [data-remove]").first(),
  ).toContainText("杭州");
});
check(
  "PLAN-008",
  async ({ page }) => {
    await destinations(page);
    await city(page, "上海");
    await page.locator("#next").click();
    await page.locator("#start").fill("2027-06-20");
    await page.locator("#end").fill("2027-06-19");
    await page.locator("#next").click();
    await expect(page.locator("#start")).toBeVisible();
    await expect(page.locator("#end")).toHaveAttribute("min", "2027-06-20");
    expect(await page.locator("#end").evaluate((e) => e.checkValidity())).toBe(
      false,
    );
  },
  "partial",
  "前端禁止倒序；后端日期校验另由接口测试覆盖",
);
async function editor(page) {
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
}
check(
  "WALK-007",
  async ({ page }) => {
    await editor(page);
    const frame = page
      .frames()
      .find(
        (f) => f.url().includes("amap-view.html") && f.url().includes("walk=1"),
      );
    await expect
      .poll(() =>
        frame.evaluate(
          () =>
            window.__uiMapMessages.filter((m) => m.kind === "citywalk").at(-1)
              ?.services?.length || 0,
        ),
      )
      .toBeGreaterThan(1);
    const scene = await frame.evaluate(() =>
      window.__uiMapMessages.filter((m) => m.kind === "citywalk").at(-1),
    );
    expect(scene.fitKey).toBeTruthy();
    expect(scene.services.every((p) => p.position?.length === 2)).toBe(true);
  },
  "partial",
  "验证真实编辑器发出全部候选坐标与相机 fit 指令；未验证高德 SDK 实际渲染",
);
check(
  "WALK-010",
  async ({ page }) => {
    let preview = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/citywalk/preview")) preview++;
    });
    await editor(page);
    await page.locator("#walk-candidates [data-place]").first().click();
    await page.locator("#walk-candidates [data-place]").first().click();
    await expect(page.locator("#walk-count")).toHaveText("2 个地点");
    await expect(page.locator("#walk-selected li")).toHaveCount(2);
    await expect(page.locator("#walk-route-state")).toContainText("连线约");
    expect(preview).toBe(0);
    await page.locator("#walk-selected [data-remove]").first().click();
    await expect(page.locator("#walk-count")).toHaveText("1 个地点");
  },
  "partial",
  "验证选点即时本地连线与无步行API请求；真实地图曲线视觉另验收",
);
check(
  "WALK-021",
  async ({ page }) => {
    await editor(page);
    await page.locator("#walk-candidates [data-place]").first().click();
    await page.locator("#walk-candidates [data-place]").first().click();
    await page.locator("#walk-save").click();
    await expect(page.locator("#walk-route-state")).toContainText(
      /预览|暂不可用/,
    );
    await expect(page.locator("#walk-save")).not.toHaveText("保存路线 ✓");
    await expect(page).toHaveURL(/citywalk\/new/);
  },
  "partial",
  "未配置高德等价于不可用依赖；额度耗尽的供应商码需真实联调",
);
check(
  "E2E-018",
  async ({ page }) => {
    for (let i = 0; i < 6; i++) {
      await page.goto("/#/history");
      await page.goto("/#/favorites");
      await page.goto("/#/settings");
    }
    await expect(page.locator("#detail-title")).toHaveText("设置");
    await expect(page.locator("#inbox-open")).toBeVisible();
    await expect(page.locator(".history-list")).toHaveCount(0);
  },
  "partial",
  "六轮连续导航；并非大规模并发压力测试",
);
