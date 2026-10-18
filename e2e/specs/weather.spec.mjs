import {test,expect,signIn} from '../fixtures.mjs';
test('WEATHER-UI-001 行程天气显示、文本转义和预警缺项',async({page,context,fixture})=>{
  await signIn(context,fixture);
  await page.route('**/api/journey/trips/*/weather?*',r=>r.fulfill({json:{status:'available',forecast:{day:'雷阵雨',lowC:20,highC:26},advice:'indoor_alternative'}}));
  await page.route('**/api/journey/trips/*/weather-alerts?*',r=>r.fulfill({json:{status:'available',items:[{title:'<img src=x onerror=alert(1)>官方测试预警',instruction:'留意出行安排'}],attributions:['预警测试数据']}}));
  await page.goto('/#/home');await page.evaluate(id=>localStorage.setItem('seatraces-last-trip',id),fixture.trip);await page.reload();
  await page.locator('[data-day="0"]').click();await page.getByRole('button',{name:'天气与预警 ☀'}).click();
  const weather=page.locator('.trip-weather');await expect(weather).toContainText('雷阵雨');await expect(weather).toContainText('20～26℃');
  await expect(weather).toContainText('室内备选');await expect(weather).toContainText('<img');await expect(weather.locator('img')).toHaveCount(0);
  await weather.screenshot({path:'reports/ui/trip-weather.png'});
});

test('WEATHER-UI-002 断网后可重新查询，超预报日期不显示虚构天气',async({page,context,fixture})=>{
  await signIn(context,fixture);let mode='future';
  await page.route('**/api/journey/trips/*/weather?*',r=>r.fulfill({json:mode==='future'
    ?{status:'outside_forecast_range',forecast:null}
    :{status:'available',forecast:{day:'多云',lowC:18,highC:25}}}));
  await page.route('**/api/journey/trips/*/weather-alerts?*',r=>r.fulfill({json:{status:'not_configured',items:[]}}));
  await page.goto('/#/home');await page.evaluate(id=>localStorage.setItem('seatraces-last-trip',id),fixture.trip);await page.reload();
  await page.locator('[data-day="0"]').click();
  const open=page.getByRole('button',{name:'天气与预警 ☀'}),weather=page.locator('.trip-weather');
  await open.click();await expect(weather).toContainText('出行日期尚未进入预报范围');await expect(weather).not.toContainText('℃');
  await expect(weather).toContainText('官方预警服务尚未配置');
  // Route abort represents loss of the weather connection without taking the
  // already loaded app shell offline or changing any server process.
  await page.route('**/api/journey/trips/*/weather?*',r=>r.abort('internetdisconnected'));
  await open.click();await expect(open).toBeEnabled();await expect(weather).not.toContainText('正在查看天气');
  await page.unroute('**/api/journey/trips/*/weather?*');mode='available';
  await page.route('**/api/journey/trips/*/weather?*',r=>r.fulfill({json:{status:'available',forecast:{day:'多云',lowC:18,highC:25}}}));
  await open.click();await expect(weather).toContainText('多云');await expect(weather).toContainText('18～25℃');await expect(open).toBeEnabled();
});
