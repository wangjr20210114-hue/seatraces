/* 验证推荐结果随用户行为的变化。 */

import {test,expect,signIn} from '../fixtures.mjs';
test('REC-ADAPT-UI-001 点赞后下一批使用新请求，保留眼前卡片并排除已显示内容',async({page,context,fixture})=>{
  await signIn(context,fixture);const calls=[];
  await page.route('**/api/social/feed**',async r=>{
    const req=r.request();calls.push({method:req.method(),body:req.method()==='POST'?req.postDataJSON():null});
    const first=req.method()==='GET',id=first?fixture.post:'00000000-0000-4000-8000-000000000002';
    return r.fulfill({json:{items:[{id,title:first?'现有旅行灵感':'下一批旅行灵感',nickname:'旅行者',excerpt:'附近慢慢逛',cities:['上海'],liked:false}],nextCursor:first?'00000000-0000-4000-8000-000000000001:1':null}});
  });
  await page.goto('/#/discover');await expect(page.locator('#discovery-content .social-card')).toHaveCount(1);
  await page.locator('#discovery-content [data-like]').click();await expect(page.locator('#discovery-content [data-like]')).toHaveAttribute('aria-pressed','true');
  await page.locator('#discovery-content .loadmore').click();await expect(page.locator('#discovery-content .social-card')).toHaveCount(2);
  expect(calls[1].method).toBe('POST');expect(calls[1].body.exclude).toContain(fixture.post);
  await expect(page.locator('#discovery-content .social-card').first()).toContainText('现有旅行灵感');
});
