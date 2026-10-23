/* 验证推荐评分与结果。 */

import {test,expect,signIn} from '../fixtures.mjs';
test('REC-UI-001 推荐曝光、行程满意度与撤回',async({page,context,fixture})=>{
 await signIn(context,fixture);
 await page.goto('/#/discover');
 const card=page.locator('[data-post="'+fixture.post+'"]');await expect(card).toBeVisible();
 await expect(card).toHaveAttribute('data-recommendation-request',/[a-f0-9-]{36}/);
 const impression=page.waitForResponse(r=>r.url().includes('/impressions')&&r.request().method()==='POST');await card.scrollIntoViewIfNeeded();expect((await impression).status()).toBe(200);
 await page.goto('/#/history/'+fixture.trip);
 const feedback=page.locator('.trip-feedback');await expect(feedback).toBeVisible();
 await feedback.locator('select[name=rating]').selectOption('4');await feedback.locator('select[name=pace]').selectOption('too_busy');await feedback.getByRole('button',{name:'保存评价'}).click();
 await expect(feedback.getByRole('status')).toHaveText('评价已保存');await page.reload();
 await expect(page.locator('.trip-feedback select[name=rating]')).toHaveValue('4');
 await page.locator('.trip-feedback').getByRole('button',{name:'撤回评价'}).click();await expect(page.locator('.trip-feedback [role=status]')).toHaveText('已撤回');
 await page.screenshot({path:'reports/recommendation/feedback-ui.png',fullPage:true});
});
