import {test,expect,signIn,get} from '../fixtures.mjs';
import {check} from '../cases.mjs';

test.beforeEach(async({context,fixture})=>signIn(context,fixture));

check('ME-011',async({page,fixture})=>{
  const saved=await get(page,'/api/citywalks/'+fixture.walk);
  expect(saved.verified_route.distanceM).toBe(saved.distance_m);
  let previews=0;
  page.on('request',r=>{if(r.url().includes('/api/citywalk/preview'))previews++;});
  await page.goto('/#/walks');
  await page.getByRole('link',{name:/UI上海步行路线/}).click();
  for(let i=0;i<2;i++){
    await expect(page.locator('#walk-title')).toHaveValue(saved.title);
    await expect(page.locator('#walk-selected li')).toHaveCount(saved.stops.length);
    for(const [index,stop] of saved.stops.entries())
      await expect(page.locator('#walk-selected li').nth(index)).toContainText(stop.name);
    await expect(page.locator('#walk-route-state')).toHaveText('步行 1.25 公里');
    await expect(page.locator('#walk-save')).toHaveText('保存路线 ✓');
    const frame=page.frames().find(f=>f.url().includes('amap-view.html')&&f.url().includes('walk=1'));
    await expect.poll(()=>frame.evaluate(()=>window.__uiMapMessages.filter(m=>m.kind==='citywalk').at(-1)?.connections)).toEqual(saved.verified_route.legs.flatMap(l=>l.paths.map(path=>({path}))));
    if(!i)await page.reload();
  }
  expect(previews).toBe(0);
  await page.locator('#walk-start').selectOption(saved.stops[1].id);
  await expect(page.locator('#walk-route-state')).toContainText('连线约');
  await expect(page.locator('#walk-save')).toHaveText('规划步行路线 →');
  expect(previews).toBe(0);
},'partial','真实数据库中已保存路线，经我的CityWalk打开和刷新，标题、站点、核验距离及路径保持；步行路径使用测试数据，付费供应商与地图底图另验收');
