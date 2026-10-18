import {test,expect,signIn} from '../fixtures.mjs';
test.beforeEach(async({context,fixture})=>signIn(context,fixture));
test('ADAPT-UI-002 整体差评不自动成为地点差评，各方面可独立保存',async({page,fixture})=>{
  await page.goto('/#/history/'+fixture.trip);const feedback=page.locator('.trip-feedback');
  await expect(feedback).toBeVisible();await feedback.locator('[name=rating]').selectOption('2');
  await expect(feedback.locator('[name=places]')).toHaveValue('');
  await feedback.locator('[name=places]').selectOption('5');await feedback.locator('[name=pace]').selectOption('too_busy');
  await feedback.getByRole('button',{name:'保存评价'}).click();await expect(feedback.locator('[role=status]')).toHaveText('评价已保存');
  await page.reload();await expect(page.locator('.trip-feedback [name=rating]')).toHaveValue('2');
  await expect(page.locator('.trip-feedback [name=places]')).toHaveValue('5');await expect(page.locator('.trip-feedback [name=pace]')).toHaveValue('too_busy');
  await page.screenshot({path:'reports/ui/feedback-dimensions.png',fullPage:true});
});
