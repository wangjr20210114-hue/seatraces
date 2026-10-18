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
