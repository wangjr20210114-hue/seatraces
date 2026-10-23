/* 验证用户兴趣与个性化推荐。 */

import {test,expect,signIn,write} from '../fixtures.mjs';
test.beforeEach(async({context,fixture})=>signIn(context,fixture));

test('PERS-UI-001 上滑追加新批、保留阅读内容与错误重试',async({page})=>{
 let calls=0,fail=false;const requests=[];
 await page.route('**/api/social/feed**',async route=>{
  const request=route.request(),url=new URL(request.url());calls++;
  if(fail){fail=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'暂时无法加载'})});}
  if(url.searchParams.get('scope')==='following')return route.fulfill({json:{items:[],nextCursor:null}});
  const n=request.method()==='POST'?request.postDataJSON().exclude.length:0;requests.push({method:request.method(),excluded:n});
  const items=Array.from({length:12},(_,i)=>({id:`00000000-0000-4000-8000-${String(n+i+1).padStart(12,'0')}`,title:`园林散步 ${n+i+1}`,nickname:'林间',excerpt:'沿着街道慢慢走，看看路边的树影。',cities:['苏州']}));
  return route.fulfill({json:{items,nextCursor:null,requestId:null}});
 });
 await page.goto('/#/discover');await expect(page.locator('#discovery-content .social-card')).toHaveCount(12);
 await expect.poll(()=>calls).toBe(1);
 await page.locator('#discovery-content .loadmore').scrollIntoViewIfNeeded();await expect(page.locator('#discovery-content .social-card')).toHaveCount(24);
 expect(requests[1]).toEqual({method:'POST',excluded:12});await expect(page.locator('#discovery-content .social-card').first()).toContainText('园林散步 1');
 fail=true;await page.locator('#discovery-content .loadmore').scrollIntoViewIfNeeded();await expect(page.locator('#discovery-content [role=status]')).toContainText('暂时');
 await expect(page.locator('#discovery-content .social-card')).toHaveCount(24);
 await page.getByRole('button',{name:'重新加载',exact:true}).click();await expect(page.locator('#discovery-content .social-card')).toHaveCount(36);
 await page.locator('[data-scope=following]').click();await expect(page.locator('#discovery-content .social-card')).toHaveCount(0);
 await expect(page.locator('#discovery-content [role=status]')).toContainText('关注喜欢的作者');
});

test('PERS-UI-002 收藏和浏览卡片显示真实接口作者、两个时间和封面',async({page,fixture})=>{
 await write(page,'/api/posts/'+fixture.post+'/reactions',{kind:'save',active:true});
 await write(page,'/api/posts/'+fixture.post+'/view',{seconds:10});
 for(const route of ['favorites','browsing']){
  await page.goto('/#/'+route);const card=page.locator('#page-content [data-post="'+fixture.post+'"]');
  await expect(card).toBeVisible();await expect(card.locator('.social-author')).not.toHaveText('');
  await expect(card.locator('.library-metadata')).toContainText('发布于');await expect(card.locator('.library-metadata')).toContainText(route==='favorites'?'收藏于':'最近浏览');
  await expect(card.locator('.library-metadata time')).toHaveCount(2);await expect(card.locator('.social-card-media')).toBeVisible();
 }
 await page.screenshot({path:'reports/ui/personalization-library.png',fullPage:true});
});

test('PERS-UI-003 父景点简介按需加载、悬浮展开并不阻塞选择',async({page})=>{
 await page.goto('/#/home');await page.locator('#begin').click();await page.locator('#origin').fill('北京');await page.locator('#next').click();
 await page.locator('#city-search').fill('上海');await page.locator('#city-results [data-city]').filter({hasText:'上海'}).first().click();await page.locator('#next').click();
 await page.locator('#start').fill('2027-06-20');await page.locator('#end').fill('2027-06-21');await page.locator('#next').click();
 const group=page.locator('[data-members]').first();await expect(group).toBeVisible();
 const response=page.waitForResponse(r=>r.url().endsWith('/description')&&r.request().method()==='POST');await group.locator(':scope > summary').click();
 const description=group.locator('[data-description-id]').first();await description.scrollIntoViewIfNeeded();
 expect((await response).status()).toBe(200);
 await expect(description).toBeVisible();await description.hover();
 await expect(description.locator('.scenic-full')).toBeVisible();await expect(description.locator('.scenic-full')).not.toBeEmpty();
 await group.locator('.wish').first().click();await expect(group.locator('.wish').first()).toHaveAttribute('aria-pressed','true');
 await group.locator('.wish').first().click();await expect(group.locator('.wish').first()).toHaveAttribute('aria-pressed','false');
 await description.hover();await expect(description.locator('.scenic-full')).toBeVisible();
 await page.screenshot({path:'reports/ui/personalization-places.png',fullPage:true});
});
