/* 验证自适应旅行问卷。 */

import {test,expect,signIn,home} from '../fixtures.mjs';
test.beforeEach(async({context,fixture})=>signIn(context,fixture));
test('ADAPT-UI-001 问题随同行人和交通变化，返回修改不保留失效分支',async({page})=>{
  await home(page);await page.locator('#begin').click();
  await page.locator('#origin').fill('上海');await page.locator('#next').click();
  await page.locator('#city-search').fill('上海');await page.locator('#city-results [data-city]').filter({hasText:'上海'}).first().click();await page.locator('#next').click();
  await page.locator('#start').fill('2027-06-20');await page.locator('#end').fill('2027-06-21');await page.locator('#next').click();
  await page.locator('button.cluster-main').first().click();await page.locator('#next').click();
  await expect(page.locator('#question-title')).toContainText('和谁');
  await page.locator('[data-answer=parents]').click();await page.locator('#next').click();
  await expect(page.locator('[data-answer="人文"]')).toBeVisible();
  while(await page.locator('#question [data-answer][aria-pressed=true]').count())await page.locator('#question [data-answer][aria-pressed=true]').first().click();
  await page.locator('[data-answer="人文"]').click();await page.locator('#next').click();
  await expect(page.locator('#question-title')).toContainText('轻松');
  await page.locator('[data-answer=relaxed]').click();await page.locator('#next').click();
  await page.locator('[data-answer=fewWalking]').click();await page.locator('#next').click();
  await expect(page.locator('#question-title')).toContainText('步行');
  await page.locator('[data-answer="3"]').click();await page.locator('#next').click();
  await expect(page.locator('#question-title')).toContainText('怎样逛');
  await page.locator('#back').click();await expect(page.locator('#question-title')).toContainText('步行');
  await page.locator('#back').click();await expect(page.locator('#question-title')).toContainText('出行');
  await page.locator('[data-answer=balanced]').click();await page.locator('#next').click();
  await expect(page.locator('#question-title')).toContainText('怎样逛');
  await page.screenshot({path:'reports/ui/adaptive-questionnaire.png',fullPage:true});
});
