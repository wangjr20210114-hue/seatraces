/* 验证行程备选方案交互。 */

import {test,expect,signIn} from '../fixtures.mjs';
test('PLAN-UI-001 比较、核验和确认保存分开，失败不可采用',async({page,context,fixture})=>{
 await signIn(context,fixture);let applied=0;
 const item={id:'9ac8c117-a338-4711-8765-25385f23be00',name:'少走路',focus:'walk',metrics:{walkingMeters:800,travelMinutes:20,visitMinutes:240,finishAt:'16:30'},verification:'required',stops:[{name:'博物馆'},{name:'园林'}],explanations:[{name:'园林',reason:'nearby_less_walking'}],excluded:[{name:'远处景点',reason:'time_budget'}]};
 await page.route('**/api/journey/trips/*/alternatives',r=>r.fulfill({json:{items:[item],unmet:[]}}));
 await page.route('**/api/journey/trips/*/alternatives/*/verify',r=>r.fulfill({json:{...item,verification:'verified'}}));
 await page.goto('/#/home');await page.evaluate(id=>localStorage.setItem('seatraces-last-trip',id),fixture.trip);await page.reload();
 await page.locator('[data-day="0"]').click();await page.getByRole('button',{name:'比较方案 ⇄'}).click();
 const card=page.locator('.alternative-card');await expect(card).toContainText('少走路');await expect(card.getByRole('button',{name:'确认采用'})).toBeDisabled();
 await card.getByText('为什么这样安排？').click();await expect(card).toContainText('距离近，少走路');
 await card.getByRole('button',{name:'核验实际路线'}).click();await expect(card.getByRole('button',{name:'确认采用'})).toBeEnabled();
 await card.screenshot({path:'reports/ui/planning-alternatives.png'});
});
