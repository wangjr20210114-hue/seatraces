/* 验证页面状态恢复。 */

import {test,expect,signIn} from '../fixtures.mjs';

const item={id:'9ac8c117-a338-4711-8765-25385f23be00',name:'少走路',metrics:{walkingMeters:800,travelMinutes:20,visitMinutes:240,finishAt:'16:30'},verification:'required',stops:[{name:'博物馆'},{name:'园林'}],explanations:[],excluded:[]};
test.beforeEach(async({context,fixture})=>signIn(context,fixture));
async function mount(page,fixture){
 await page.goto('/#/home');
 await page.evaluate(async({id})=>{
  const {mountPlanningAlternatives}=await import('/planning-alternatives.js');
  const host=document.createElement('div');host.id='recovery-plans';document.body.append(host);
  host.style.cssText='position:fixed;inset:0;background:#fffdf0;z-index:99999;overflow:auto;padding:30px';
  window.__recoverySaved=[];
  const api=async(path,body,method=body?'POST':'GET')=>{
   const r=await fetch(path,{method,headers:{'Content-Type':'application/json','X-Seatraces':'1'},...(body?{body:JSON.stringify(body)}:{})});
   const v=await r.json();if(!r.ok)throw Object.assign(Error(v.error||'连接失败'),{status:r.status});return v;
  };
  mountPlanningAlternatives({element:host,trip:{id,version:1},day:0,api,onSaved:t=>window.__recoverySaved.push(t.version)});
 },{id:fixture.trip});
 return page.locator('#recovery-plans');
}
test('RECOVERY-001 比较与路线核验断网保留已有方案，恢复后可重试',async({page,context,fixture})=>{
 await page.route('**/api/journey/trips/*/alternatives',r=>r.fulfill({json:{items:[item],unmet:[]}}));
 await page.route('**/api/journey/trips/*/alternatives/*/verify',r=>r.fulfill({json:{...item,verification:'verified'}}));
 const host=await mount(page,fixture);await host.getByRole('button',{name:'比较方案 ⇄'}).click();await expect(host.locator('.alternative-card')).toHaveCount(1);
 await page.unroute('**/api/journey/trips/*/alternatives');await context.setOffline(true);
 await host.getByRole('button',{name:'比较方案 ⇄'}).click();await expect(host.locator('[role=status]')).not.toBeEmpty();
 await expect(host.locator('.alternative-card')).toHaveCount(1);
 await page.unroute('**/api/journey/trips/*/alternatives/*/verify');
 await host.getByRole('button',{name:'核验实际路线'}).click();await expect(host.getByRole('button',{name:'确认采用'})).toBeDisabled();
 await context.setOffline(false);await page.route('**/api/journey/trips/*/alternatives/*/verify',r=>r.fulfill({json:{...item,verification:'verified'}}));
 await host.getByRole('button',{name:'核验实际路线'}).click();await expect(host.getByRole('button',{name:'确认采用'})).toBeEnabled();
});

test('RECOVERY-002 保存已提交但响应丢失，核对预览标识恢复且不重复写入',async({page,fixture})=>{
 await page.route('**/api/journey/trips/*/alternatives',r=>r.fulfill({json:{items:[item],unmet:[]}}));
 await page.route('**/api/journey/trips/*/alternatives/*/verify',r=>r.fulfill({json:{...item,verification:'verified'}}));
 let writes=0,version=1;
 await page.route('**/api/trips/'+fixture.trip,async r=>{
  if(r.request().method()==='PATCH'){writes++;version=2;return r.abort('connectionreset');}
  return r.fulfill({json:{id:fixture.trip,version,plan:{days:[{planningExplanation:{previewId:item.id}}]}}});
 });
 const host=await mount(page,fixture);await host.getByRole('button',{name:'比较方案 ⇄'}).click();await host.getByRole('button',{name:'核验实际路线'}).click();await host.getByRole('button',{name:'确认采用'}).click();
 await expect.poll(()=>page.evaluate(()=>window.__recoverySaved)).toEqual([2]);expect(writes).toBe(1);
});

test('RECOVERY-003 他人更新的版本不能被误认为本次提交成功',async({page,fixture})=>{
 await page.route('**/api/journey/trips/*/alternatives',r=>r.fulfill({json:{items:[item],unmet:[]}}));
 await page.route('**/api/journey/trips/*/alternatives/*/verify',r=>r.fulfill({json:{...item,verification:'verified'}}));
 await page.route('**/api/trips/'+fixture.trip,r=>r.request().method()==='PATCH'?r.fulfill({status:409,json:{error:'行程已更新'}}):r.fulfill({json:{version:2,plan:{days:[{planningExplanation:{previewId:'another-preview'}}]}}}));
 const host=await mount(page,fixture);await host.getByRole('button',{name:'比较方案 ⇄'}).click();await host.getByRole('button',{name:'核验实际路线'}).click();await host.getByRole('button',{name:'确认采用'}).click();
 await expect(host.locator('[role=status]')).toContainText('行程已更新');expect(await page.evaluate(()=>window.__recoverySaved)).toEqual([]);
});

test('RECOVERY-004 问卷下一题断网保留已选条件，恢复后继续',async({page,context})=>{
 await page.goto('/#/home');await page.locator('#begin').click();await page.locator('#origin').fill('上海');await page.locator('#next').click();
 await page.locator('#city-search').fill('上海');await page.locator('#city-results [data-city]').filter({hasText:'上海'}).first().click();await page.locator('#next').click();
 await page.locator('#start').fill('2027-06-20');await page.locator('#end').fill('2027-06-21');await page.locator('#next').click();
 const cluster=page.locator('button.cluster-main').first();if(await cluster.getAttribute('aria-pressed')==='false')await cluster.click();await page.locator('#next').click();await expect(page.locator('#question-title')).toContainText('和谁');
 await page.locator('[data-answer=parents]').click();await context.setOffline(true);await page.locator('#next').click();
 await expect(page.locator('#form-error')).not.toBeEmpty();await expect(page.locator('[data-answer=parents]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#next')).toBeEnabled();
 await context.setOffline(false);await page.locator('#next').click();await expect(page.locator('[data-answer="人文"]')).toBeVisible();
});

test('RECOVERY-005 问AI断网保留输入，恢复后按正常接口导航',async({page,context})=>{
 await page.goto('/#/agent');await page.getByRole('button',{name:'新对话',exact:true}).click();
 const input=page.getByLabel('发给问 AI 的消息');await input.fill('打开我的收藏');await context.setOffline(true);
 await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.locator('.agent-error')).toBeVisible();await expect(input).toHaveValue('打开我的收藏');
 await context.setOffline(false);await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page).toHaveURL(/#\/favorites/);
});

test('RECOVERY-006 网络恢复重新初始化地图，保留当前行程和日期',async({page,context,fixture})=>{
 await page.goto('/#/home');await expect(page.locator('body')).not.toHaveClass(/auth-pending/);
 await page.evaluate(id=>localStorage.setItem('seatraces-last-trip',id),fixture.trip);await page.reload();await page.locator('[data-day="1"]').click();
 let frameLoads=0;page.on('framenavigated',frame=>{if(frame.url().includes('/amap-view.html'))frameLoads++;});
 const before=await page.locator('.trip-head h2').innerText();
 await context.setOffline(true);await page.evaluate(()=>window.dispatchEvent(new Event('offline')));
 await context.setOffline(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await expect.poll(()=>frameLoads).toBeGreaterThan(0);
 await expect(page.locator('.trip-head h2')).toHaveText(before);await expect(page.locator('[data-day="1"]')).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('#connection-status')).toBeHidden();
});
