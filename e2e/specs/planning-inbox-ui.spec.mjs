import { test, expect, signIn, get, write, loginUI } from '../fixtures.mjs';
import { randomUUID } from 'node:crypto';

async function deliver(browser, fixture, body = '出发前记得看一眼天气。\n祝你玩得开心！') {
  const admin = await browser.newContext({ baseURL: 'http://127.0.0.1:19888' });
  await signIn(admin, fixture, 'admin', true);
  const page = await admin.newPage(), id = randomUUID();
  try {
    await write(page, '/api/admin/messages', { id, title: '旅行小提醒', body, audience: 'selected', recipientIds: [fixture.a.id] });
    const preview = await get(page, `/api/admin/messages/${id}/preview`);
    await write(page, `/api/admin/messages/${id}/send`, { version: preview.version, recipientCount: preview.eligibleRecipients, confirmation: 'send' });
  } finally { await admin.close(); }
}
test.beforeEach(async ({ context, page, fixture }) => {
  await signIn(context, fixture);
  const messages = await get(page, '/api/me/messages?limit=100&unread=1');
  for (const m of messages.items) await write(page, `/api/me/messages/${m.id}/read`, {});
});

test('login displays the newest unread body, dismiss retains unread and reading clears both badges', async ({ browser, context, page, fixture }, info) => {
  await deliver(browser, fixture, '<script>literal text</script>\n明天慢慢逛。');
  // A newer read message must not hide an older unread one.
  await deliver(browser, fixture, '这封已读');
  const latest = (await get(page, '/api/me/messages?limit=1')).items[0];
  await write(page, `/api/me/messages/${latest.id}/read`, {});
  await context.clearCookies();
  await loginUI(page, fixture);
  const modal = page.getByRole('dialog', { name: '旅行小提醒' });
  await expect(modal).toContainText('<script>literal text</script>');
  await expect(modal.locator('script')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('login-message-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(modal).toBeVisible();
  await page.screenshot({ path: info.outputPath('login-message-mobile.png') });
  await modal.getByRole('button', { name: '稍后阅读' }).click();
  expect((await get(page, '/api/me/messages?unread=1')).unread).toBe(1);
  await page.reload();
  await expect(page.locator('.inbox-welcome')).toHaveCount(0);
  await page.locator('[data-page="profile"]').click();
  await expect(page.locator('[data-inbox-link] .inbox-badge')).toBeVisible();
  await expect(page.locator('[data-inbox-link] svg')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('profile-icons-mobile.png') });
  await page.locator('[data-inbox-link]').click();
  await page.locator('.inbox-item.unread').click();
  await expect(page.locator('.inbox-letter')).toContainText('明天慢慢逛。');
  await expect.poll(async () => (await get(page, '/api/me/messages?unread=1')).unread).toBe(0);
  await expect(page.locator('[data-inbox-badge]:not([hidden])')).toHaveCount(0);
});

test('new messages while signed in update badges without interrupting the page, including the polling interval', async ({ browser, page, fixture }) => {
  await page.clock.install();
  const firstCheck = page.waitForResponse(r => r.url().endsWith('/api/me/messages?limit=1&unread=1'));
  await page.goto('/#/profile');
  await expect(page.locator('#profile-name')).toHaveText('UI测试a');
  await firstCheck;
  await expect.poll(async () => (await get(page, '/api/me/messages?unread=1')).unread).toBe(0);
  await deliver(browser, fixture);
  await page.clock.runFor(31000);
  await expect(page.locator('[data-inbox-link] .inbox-badge')).toBeVisible();
  await expect(page.locator('.inbox-welcome')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/profile/);
  await page.locator('a[aria-label="设置"]').click();
  await expect(page.locator('#inbox-open [data-inbox-badge]')).toHaveText('1');
});

test('an old unread response cannot show the previous account message after switching account', async ({ context, page, fixture }) => {
  let release, requested;
  const seen = new Promise(resolve => requested = resolve);
  const gate = new Promise(resolve => release = resolve);
  await page.route('**/api/me/messages?limit=1&unread=1', async route => {
    if (route.request().headers().cookie?.includes(fixture.a.token)) {
      requested(); await gate;
      await route.fulfill({ json: { userId: fixture.a.id, unread: 8, items: [{ id: randomUUID() }], hasMore: true } });
    } else await route.continue();
  });
  await page.goto('/#/profile');
  await seen;
  await signIn(context, fixture, 'b');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#profile-name')).toHaveText('UI测试b');
  release();
  await expect(page.locator('[data-inbox-badge]:not([hidden])')).toHaveCount(0);
  await expect(page.locator('.inbox-welcome')).toHaveCount(0);
});

test('AI plans with preferences without area or repeated preference questions', async ({ page }, info) => {
  const replies = [], writes = [];
  page.on('response', async r => { if (/\/api\/agent\/conversations\/.*\/(messages|actions\/[^/]+)$/.test(r.url())) replies.push(await r.json()); });
  page.on('request', r => { if (r.method() === 'POST') writes.push(r.url()); });
  await page.goto('/#/agent');
  await page.getByLabel('发给问 AI 的消息').fill('我从上海去上海，2026-11-01出发，2026-11-02返回，想看博物馆，少走路');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.agent-action').last()).toContainText('按我的偏好安排旅行');
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(page.locator('.agent-action').last()).toContainText('生成并保存旅行方案', { timeout: 60000 });
  expect(replies.some(r => ['clusters', 'preference'].includes(r.question?.key))).toBe(false);
  await expect(page.locator('.agent-action').last()).toContainText('少走路');
  await page.screenshot({ path: info.outputPath('ai-automatic-plan.png') });
  if (process.env.UI_PLANNER_MODEL === '1') {
    await page.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(page.locator('.agent-log')).toContainText('旅行方案已保存', { timeout: 60000 });
    expect(writes.filter(p => /\/actions\//.test(p))).toHaveLength(2);
    expect(replies.findLast(r => r.tripId)?.tripId).toBeTruthy();
  } else {
    await page.locator('.agent-action').last().getByRole('button', {name:'取消',exact:true}).click();
    await expect(page.locator('.agent-log')).toContainText('已取消');
  }
});

test('primary controls keep the same SVG style on desktop and phone', async ({ page }, info) => {
  await page.goto('/#/home');
  await page.locator('#begin').click();
  await expect(page.locator('#next svg')).toHaveCount(1);
  await expect(page.locator('#close svg')).toHaveCount(1);
  await expect(page.locator('#locate svg')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('planner-icons-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('planner-icons-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '收起问卷' }).click();
  await page.locator('[data-page="profile"]').click();
  await page.locator('a[aria-label="设置"]').click();
  await expect(page.locator('.settings-menu .tile-icon svg')).toHaveCount(5);
  await page.screenshot({ path: info.outputPath('settings-icons-mobile.png') });
});
