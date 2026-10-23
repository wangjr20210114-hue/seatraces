/* 验证旅行问卷页面恢复。 */

import {test,expect,signIn,home} from '../fixtures.mjs';
import {chromium} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
async function cityStep(page){
 await page.locator('#begin').click();await page.locator('#origin').fill('北京');await page.locator('#next').click();
 await page.locator('#city-search').fill('上海');await page.locator('#city-results [data-city]').filter({hasText:'上海'}).first().click();await page.locator('#next').click();
 await page.locator('#start').fill('2027-06-20');await page.locator('#end').fill('2027-06-21');await page.locator('#next').click();
 await expect(page.locator('.cluster-main').first()).toBeVisible();
}
async function draft(page){return page.evaluate(()=>{const key=Object.keys(localStorage).find(k=>k.startsWith('seatraces-journey-draft:'));return key?JSON.parse(localStorage.getItem(key)).progress:null;});}
test.beforeEach(async({context,fixture,page})=>{await signIn(context,fixture);await home(page);});

test('DRAFT-001 已选片区、离线想去和当前页经刷新及重新打开页面保留，联网同步',async({page,context})=>{
 await cityStep(page);const cluster=page.locator('.cluster-main').first();const group=await cluster.getAttribute('data-cluster');
 if(await cluster.getAttribute('aria-pressed')==='false')await cluster.click();
 const details=page.locator('[data-members="'+group+'"]');await details.locator(':scope > summary').click();
 const wish=details.locator('[data-wanted]').first(),place=await wish.getAttribute('data-wanted'),wanted=await wish.getAttribute('aria-pressed')!=='true';
 await context.setOffline(true);await wish.click();await expect(wish).toHaveAttribute('aria-pressed',String(wanted));
 const saved=await draft(page);expect(saved.pendingWishes[place]).toBe(wanted);expect(Object.values(saved.selections).flat()).toContain(group);
 await context.setOffline(false);await page.reload();await expect(page.locator('#wizard')).toBeVisible();await expect(page.locator('[data-cluster="'+group+'"]')).toHaveAttribute('aria-pressed','true');
 await expect.poll(async()=>Object.keys((await draft(page)).pendingWishes).length).toBe(0);
 const state=await context.storageState();const browser=context.browser(),next=await browser.newContext({storageState:state});
 await next.route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
 const reopened=await next.newPage();await reopened.goto('http://127.0.0.1:19888/#/home');await expect(reopened.locator('[data-cluster="'+group+'"]')).toHaveAttribute('aria-pressed','true');await next.close();
});

test('DRAFT-002 选好的答案无需点下一题即可恢复；断网启动后可重连继续',async({page,context})=>{
 await cityStep(page);const cluster=page.locator('.cluster-main').first();if(await cluster.getAttribute('aria-pressed')==='false')await cluster.click();
 await page.locator('#next').click();await page.locator('[data-answer=parents]').click();
 expect((await draft(page)).answers.companion).toBe('parents');
 await page.reload();await expect(page.locator('[data-answer=parents]')).toHaveAttribute('aria-pressed','true');
 await page.route('**/api/me',r=>r.abort('internetdisconnected'));await page.reload();await expect(page.locator('#auth-retry')).toBeVisible();
 await page.unroute('**/api/me');await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.locator('[data-answer=parents]')).toHaveAttribute('aria-pressed','true');
});

test('DRAFT-003 创建问卷成功但响应丢失，刷新后用同一标识重试',async({page})=>{
 await page.locator('#begin').click();await page.locator('#origin').fill('北京');await page.locator('#next').click();
 await page.locator('#city-search').fill('上海');await page.locator('#city-results [data-city]').filter({hasText:'上海'}).first().click();await page.locator('#next').click();
 await page.locator('#start').fill('2027-06-20');await page.locator('#end').fill('2027-06-21');
 let lost=true,firstId;
 await page.route('**/api/journey/sessions',async r=>{const id=JSON.parse(r.request().postData()).clientSessionId;firstId ||= id;expect(id).toBe(firstId);if(lost){lost=false;const response=await r.fetch();expect(response.status()).toBe(201);return r.abort('connectionreset');}return r.continue();});
 await page.locator('#next').click();await expect(page.locator('#form-error')).not.toBeEmpty();expect((await draft(page)).clientSessionId).toBe(firstId);
 await page.reload();await expect(page.locator('#start')).toHaveValue('2027-06-20');await page.locator('#next').click();await expect(page.locator('.cluster-main').first()).toBeVisible();
 expect((await draft(page)).sessionId).toBe(firstId);
});

test('DRAFT-005 真实浏览器配置目录关闭重启后恢复，未登录前不展示草稿',async({fixture})=>{
 const root=path.resolve('.runtime/ui-test'),profile=await mkdtemp(path.join(root,'recovery-profile-'));let ctx;
 async function open(){
  ctx=await chromium.launchPersistentContext(profile,{headless:true,...(process.env.UI_BROWSER?{channel:process.env.UI_BROWSER}:{}),viewport:{width:1280,height:900}});
  await ctx.route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
  return ctx.pages()[0]||await ctx.newPage();
 }
 try{
  let p=await open();await signIn(ctx,fixture);await p.goto('http://127.0.0.1:19888/#/home');await p.locator('#begin').click();await p.locator('#origin').fill('杭州');
  expect((await draft(p)).origin.label).toBe('杭州');await ctx.close();ctx=null;
  p=await open();await ctx.clearCookies();await p.goto('http://127.0.0.1:19888/#/home');await expect(p.locator('body')).not.toHaveClass(/auth-pending/);await expect(p.locator('#wizard')).not.toBeVisible();
  await signIn(ctx,fixture);await p.reload();await expect(p.locator('#origin')).toHaveValue('杭州');
 }finally{await ctx?.close();if(path.dirname(profile)!==root)throw Error('Invalid test profile');await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});

test('DRAFT-006 本机存储不可用明确提示，不虚报保存成功',async({page})=>{
 await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('seatraces-journey-draft:'))throw new DOMException('Quota','QuotaExceededError');return original.call(this,k,v);};});
 await page.locator('#begin').click();await page.locator('#origin').fill('杭州');await expect(page.locator('#draft-status')).toHaveText('本机保存失败，请勿关闭页面');
});

test('DRAFT-007 快速反复点想去，慢响应不会覆盖最后一次选择',async({page})=>{
 await cityStep(page);const details=page.locator('[data-members]').first();await details.locator(':scope > summary').click();const wish=details.locator('[data-wanted]').first();
 const before=await wish.getAttribute('aria-pressed'),place=await wish.getAttribute('data-wanted');let calls=0;
 await page.route('**/api/journey/sessions/*/wishes',async r=>{calls++;const response=await r.fetch();if(calls===1)await new Promise(done=>setTimeout(done,700));return r.fulfill({response});});
 for(let i=0;i<15;i++)await wish.click();
 await expect(wish).toHaveAttribute('aria-pressed',String(before!=='true'));await expect.poll(async()=>Object.keys((await draft(page)).pendingWishes).length).toBe(0);
 expect(calls).toBeLessThanOrEqual(15);await page.reload();await page.locator('[data-members]').first().locator(':scope > summary').click();await expect(page.locator('[data-wanted="'+place+'"]')).toHaveAttribute('aria-pressed',String(before!=='true'));
});

test('DRAFT-008 生成成功但响应丢失，恢复已生成行程且不再生成，完成后不复活草稿',async({page,fixture})=>{
 await cityStep(page);const saved=await draft(page);let generates=0;
 await page.route('**/api/journey/sessions/'+saved.sessionId,r=>r.fulfill({json:{id:saved.sessionId,tripId:fixture.trip}}));
 await page.route('**/api/journey/sessions/*/generate',r=>{generates++;return r.abort();});
 await page.reload();await expect(page.locator('[data-day="0"]')).toBeVisible();expect(generates).toBe(0);await expect.poll(()=>draft(page)).toBe(null);
 await page.reload();expect(await draft(page)).toBe(null);await expect(page.locator('#wizard')).not.toBeVisible();
});

test('DRAFT-004 服务拒绝或临时错误不删除本机进度，其他账号不恢复它',async({page,context,fixture})=>{
 await cityStep(page);const before=await draft(page);
 await page.route('**/api/journey/sessions/'+before.sessionId,r=>r.fulfill({status:503,json:{error:'暂时不可用'}}));
 await page.reload();await expect(page.locator('#resume-wizard')).toBeVisible();expect((await draft(page)).sessionId).toBe(before.sessionId);
 await page.unroute('**/api/journey/sessions/'+before.sessionId);await page.locator('#resume-wizard').click();await expect(page.locator('.cluster-main').first()).toBeVisible();
 await signIn(context,fixture,'b');await page.reload();await expect(page.locator('#wizard')).not.toBeVisible();
});

test('DRAFT-009 日期未失焦也立即保存；参考帖子不能在恢复时重新覆盖取消的想去',async({page})=>{
 await page.locator('#begin').click();await page.locator('#origin').fill('北京');await page.locator('#next').click();
 await page.locator('#city-search').fill('上海');await page.locator('#city-results [data-city]').filter({hasText:'上海'}).first().click();await page.locator('#next').click();
 await expect(page.locator('#start')).toBeVisible();
 await page.evaluate(()=>{for(const [id,value]of [['start','2027-06-20'],['end','2027-06-21']]){const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}});
 expect((await draft(page)).end).toBe('2027-06-21');await page.reload();await expect(page.locator('#end')).toHaveValue('2027-06-21');
 await page.locator('#next').click();const details=page.locator('[data-members]').first();await details.locator(':scope > summary').click();const wish=details.locator('[data-wanted]').first(),place=await wish.getAttribute('data-wanted');
 if(await wish.getAttribute('aria-pressed')==='true')await wish.click();await expect.poll(async()=>Object.keys((await draft(page)).pendingWishes).length).toBe(0);
 await page.evaluate(place=>{const key=Object.keys(localStorage).find(k=>k.startsWith('seatraces-journey-draft:'));const r=JSON.parse(localStorage.getItem(key));r.progress.inspiration={postId:crypto.randomUUID(),placeIds:[place]};localStorage.setItem(key,JSON.stringify(r));},place);
 let writes=0;await page.route('**/api/journey/sessions/*/wishes',r=>{writes++;return r.continue();});await page.reload();await page.locator('[data-members]').first().locator(':scope > summary').click();
 await expect(page.locator('[data-wanted="'+place+'"]')).toHaveAttribute('aria-pressed','false');expect(writes).toBe(0);
 await page.locator('#wizard').screenshot({path:'reports/ui/questionnaire-recovery.png'});
});
