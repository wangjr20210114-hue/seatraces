import { test, expect, signIn, get, write } from "../fixtures.mjs";
import { check } from "../cases.mjs";
test.beforeEach(async ({ context, fixture }) => {
  await signIn(context, fixture);
  // Make individual UI-panel reruns independent of previous reaction/follow state.
  const client = { request: context.request };
  for (const kind of ["like", "save", "recommend"])
    await write(client, "/api/posts/" + fixture.post + "/reactions", {
      kind,
      active: false,
    });
  await write(
    client,
    "/api/social/authors/" + fixture.b.id + "/follow",
    { active: false },
    "PUT",
  );
  await write(
    client,
    "/api/social/posts/" + fixture.post + "/feedback",
    { notInterested: false },
    "PUT",
  );
});
check("SOC-005", async ({ page }) => {
  await page.goto("/#/discover");
  await page.getByLabel("搜索旅行灵感").fill("UI外滩");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator(".social-feed")).toContainText("UI外滩慢慢走");
  await page.getByLabel("搜索旅行灵感").fill("没有这种路线xyz");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator(".social-feed article")).toHaveCount(0);
  await expect(page.locator("#discovery-content [role=status]")).toContainText(
    "还没有",
  );
});
check("SOC-008", async ({ page }) => {
  await page.goto("/#/discover");
  await page.locator("[data-scope=following]").click();
  await expect(page.locator(".social-feed article")).toHaveCount(0);
  await expect(page.locator("#discovery-content")).toContainText(
    "关注喜欢的作者",
  );
});
check("SOC-009", async ({ page, fixture }) => {
  await page.goto("/#/post/" + fixture.post);
  await page.locator("[data-follow]").click();
  await expect(page.locator("[data-follow]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.goto("/#/discover");
  await page.locator("[data-scope=following]").click();
  await expect(page.locator(".social-feed")).toContainText("UI外滩慢慢走");
  await page.goto("/#/post/" + fixture.post);
  await page.locator("[data-follow]").click();
  await expect(page.locator("[data-follow]")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});
check(
  "SOC-011",
  async ({ page, fixture }) => {
    await page.goto("/#/post/" + fixture.post);
    await page.locator("[data-reaction=like]").click();
    await expect(page.locator("[data-reaction=like]")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "取消点赞", exact: true }),
    ).toBeVisible();
    await page.locator("[data-reaction=like]").click();
    await expect(page.locator("[data-reaction=like]")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  },
  "partial",
  "覆盖点赞持久与取消；数量并发另由接口用例校验",
);
check("SOC-012", async ({ page, fixture }) => {
  await page.goto("/#/post/" + fixture.post);
  await page.locator("[data-reaction=save]").click();
  await expect(page.locator("[data-reaction=save]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.goto("/#/favorites");
  await expect(page.locator("#page-content")).toContainText("UI外滩慢慢走");
});
check("SOC-013", async ({ page, fixture }) => {
  await page.goto("/#/post/" + fixture.post);
  await page.locator("[data-reaction=recommend]").click();
  await expect(page.locator("[data-reaction=recommend]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("[data-reaction=like]")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.reload();
  await expect(page.locator("[data-reaction=recommend]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
check("SOC-019", async ({ page, fixture }) => {
  await page.goto("/#/post/" + fixture.post);
  const text = "UI评论 " + Date.now();
  await page.getByLabel("评论内容").fill(text);
  await page.locator(".post-comments button").click();
  await expect(page.locator(".comment-list")).toContainText(text);
  await page.reload();
  await expect(page.locator(".comment-list")).toContainText(text);
});
check("SOC-021", async ({ page, fixture }) => {
  await page.goto("/#/post/" + fixture.post);
  const text = '<img src=x onerror="alert(1)">';
  await page.getByLabel("评论内容").fill(text);
  await page.locator(".post-comments button").click();
  await expect(page.locator(".comment-list")).toContainText(text);
  await expect(page.locator(".comment-list img")).toHaveCount(0);
});
check("SOC-022", async ({ page, fixture }) => {
  await page.goto("/#/post/" + fixture.post);
  await page.getByRole("button", { name: "不感兴趣", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "恢复此类推荐" }),
  ).toBeVisible();
  await page.goto("/#/discover");
  await expect(
    page.locator('.social-feed [data-post="' + fixture.post + '"]'),
  ).toHaveCount(0);
  await page.goto("/#/post/" + fixture.post);
  await page.getByRole("button", { name: "恢复此类推荐" }).click();
  await expect(
    page.getByRole("button", { name: "不感兴趣", exact: true }),
  ).toBeVisible();
});
async function blankDraft(page) {
  await page.goto("/#/compose/new");
  await page.getByRole("button", { name: /直接写一篇/ }).click();
  await expect(page.locator("#post-title")).toBeVisible();
}
check("POST-001", async ({ page }) => {
  await blankDraft(page);
  await page.locator("#post-title").fill("UI不带路线草稿");
  await page.locator("#post-body").fill("这是独立的旅行分享。");
  await page.locator("[data-save]").click();
  await expect(page.locator(".social-composer [role=status]")).toHaveText(
    "草稿已保存",
  );
  await page.reload();
  await expect(page.locator("#post-title")).toHaveValue("UI不带路线草稿");
});
check(
  "POST-002",
  async ({ page, fixture }) => {
    await page.goto("/#/compose/new");
    await page.getByRole("button", { name: /带上历史行程/ }).click();
    await expect(page.locator(".source-card").first()).toBeVisible();
    await expect(
      page.locator(".source-card").first().locator("img,svg"),
    ).not.toHaveCount(0);
    await page.locator('[data-id="' + fixture.trip + '"]').click();
    await expect(page.locator(".composer-route")).toContainText("行程");
  },
  "partial",
  "真实选择与草稿绑定；未配置高德时只验收封面降级",
);
check(
  "POST-003",
  async ({ page, fixture }) => {
    await page.goto("/#/compose/new");
    await page.getByRole("button", { name: /带上 CityWalk/ }).click();
    await page.locator('[data-id="' + fixture.walk + '"]').click();
    await expect(page.locator(".composer-route")).toContainText("CityWalk");
  },
  "partial",
  "真实CityWalk草稿绑定；真实底图另需高德联调",
);
check("POST-005", async ({ page }) => {
  await blankDraft(page);
  await page.locator("#post-title").fill("UI自动保存");
  await page.locator("#post-body").fill("不点保存，等待自动保存完成。");
  await expect(page.locator(".social-composer [role=status]")).toHaveText(
    "草稿已保存",
  );
  await page.reload();
  await expect(page.locator("#post-body")).toHaveValue(
    "不点保存，等待自动保存完成。",
  );
});
check(
  "POST-015",
  async ({ page }) => {
    await blankDraft(page);
    await page.locator("input[type=file]").setInputFiles({
      name: "broken.png",
      mimeType: "image/png",
      buffer: Buffer.from("not-an-image"),
    });
    await expect(page.locator(".social-composer [role=status]")).not.toHaveText(
      /正在整理|草稿已保存/,
    );
    await expect(page.locator(".composer-photos img")).toHaveCount(0);
  },
  "partial",
  "损坏PNG拒绝；其他格式和大小边界留接口/人工用例",
);
check("POST-025", async ({ page }) => {
  await blankDraft(page);
  const title = "UI发布 " + Date.now();
  await page.locator("#post-title").fill(title);
  await page.locator("#post-body").fill("在隔离测试库发布的测试文章。");
  await page.locator("[data-publish]").click();
  await expect(page).toHaveURL(/#\/post\//);
  await expect(page.locator(".social-post h1")).toHaveText(title);
  await page.reload();
  await expect(page.locator(".post-body")).toContainText("隔离测试库");
});
check("POST-030", async ({ page, fixture }) => {
  await page.goto("/#/post/" + fixture.post);
  await expect(page.locator("[data-edit]")).toHaveCount(0);
  const r = await page.request.post("/api/social/drafts", {
    data: { id: crypto.randomUUID(), postId: fixture.post },
    headers: { "X-Seatraces": "1" },
  });
  expect([403, 404]).toContain(r.status());
});
