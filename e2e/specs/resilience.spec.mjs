import { test, expect, signIn, get } from "../fixtures.mjs";
import { check } from "../cases.mjs";
test.beforeEach(async ({ context, fixture }) => signIn(context, fixture));
check(
  "E2E-014",
  async ({ page }) => {
    await page.goto("/#/account");
    const before = (await get(page, "/api/me")).user.nickname;
    const status = await page.evaluate(async () => {
      const r = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: "不应保存" }),
      });
      return r.status;
    });
    expect(status).toBe(403);
    expect((await get(page, "/api/me")).user.nickname).toBe(before);
    for(const headers of [
      {'X-Seatraces':'1',Origin:'https://outside.invalid'},
      {'X-Seatraces':'1',Origin:'null'},
      {'X-Seatraces':'1',Origin:'http://127.0.0.1:19888','Sec-Fetch-Site':'cross-site'},
    ]){
      // Browser fetch cannot forge Origin. APIRequestContext exercises the
      // server's raw-header boundary without contacting another site.
      const response=await page.request.patch('/api/me',{headers,data:{nickname:'不应保存'}});
      expect(response.status()).toBe(403);
      expect((await get(page,'/api/me')).user.nickname).toBe(before);
    }
    const valid=await page.request.patch('/api/me',{
      headers:{'X-Seatraces':'1',Origin:'http://127.0.0.1:19888','Sec-Fetch-Site':'same-origin'},
      data:{nickname:before},
    });
    expect(valid.status()).toBe(200);
  },
  "partial",
  "浏览器缺标头与HTTP Origin/Sec-Fetch-Site矩阵均拒绝写入；真实跨站Cookie链路另测",
);
check(
  "E2E-016",
  async ({ page }) => {
    await page.route("**/api/**", (r) =>
      r.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "UI测试：后端不可用" }),
      }),
    );
    await page.goto("/#/home");
    await expect(page.locator("#auth-loading")).toBeVisible();
    await expect(page.locator("#auth-loading span")).toHaveText(
      "暂时连不上服务，请稍后重试",
    );
    await expect(page.locator("#auth-retry")).toBeVisible();
    await page.unroute("**/api/**");
    await page.locator("#auth-retry").click();
    await expect(page.locator("#auth-loading")).toBeHidden();
    await expect(page.locator("#begin")).toBeVisible();
    await expect(
      page.locator("#classic-walks [data-classic]").first(),
    ).toBeVisible();
    // A failure limited to the public classics endpoint is recoverable too,
    // without reloading the page or signing in again.
    await page.route("**/api/citywalk/classics", (r) => r.fulfill({
      status: 503, contentType: "application/json",
      body: JSON.stringify({ error: "UI测试：经典路线不可用" }),
    }));
    await page.reload();
    await expect(page.locator("#auth-loading")).toBeHidden();
    await expect(page.locator("[data-classics-retry]")).toBeVisible();
    await page.unroute("**/api/citywalk/classics");
    await page.locator("[data-classics-retry]").click();
    await expect(page.locator("#classic-walks [data-classic]").first()).toBeVisible();
  },
  "partial",
  "浏览器注入API 503，恢复后重连可加载经典路线；单独经典路线503也可原地重试。未停止真实后台进程，也未验收后台缓存策略",
);
