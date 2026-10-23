/* 验证天气预报整理与展示。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeForecast,weatherForDate,createWeatherService,weatherAdcode} from '../server/services/weather.mjs';
import {normalizeAlerts,createWeatherAlerts} from '../server/integrations/weather-alerts.mjs';
const now=Date.parse('2026-10-18T08:00:00Z');
const raw={forecasts:[{reporttime:'2026-10-18 15:00:00',casts:[{date:'2026-10-18',dayweather:'雷阵雨',nightweather:'阴',daytemp:'35',nighttemp:'20'}]}]};
test('weather keeps provider timestamps, distinguishes derived advice from official alerts and rejects future/stale facts',()=>{
  const payload=normalizeForecast(raw,now);assert.deepEqual(payload.days[0].risks,['precipitation','heat']);
  assert.equal(weatherForDate(payload,'2026-10-18',now).advice,'indoor_alternative');
  assert.equal(weatherForDate(payload,'2026-11-01',now).status,'outside_forecast_range');
  assert.equal(weatherForDate(payload,'2026-10-18',now+3600001).forecast,null);
  assert.equal(payload.alerts.status,'unavailable');assert.equal(payload.alerts.items.length,0);
  assert.throws(()=>normalizeForecast({forecasts:[{reporttime:'2099-01-01 00:00:00',casts:[]}]},now));
  assert.throws(()=>normalizeForecast({},now));
});
test('same city concurrent requests share one bounded provider request and reuse persisted weather',async()=>{
  const cache=new Map();let calls=0;
  const service=createWeatherService({query:async(sql,v)=>{if(sql.startsWith('SELECT'))return {rows:cache.has(v[0])?[{payload:cache.get(v[0])}]:[]};cache.set(v[0],v[1]);return {rows:[]};},
    resolveCode:async()=> '310000',enabled:()=>true,now:()=>now,call:async(path,args)=>{calls++;assert.equal(path,'v3/weather/weatherInfo');assert.equal(args.extensions,'all');await new Promise(r=>setTimeout(r,10));return raw;}});
  const rs=await Promise.all(Array.from({length:20},()=>service.get({country:'CN'},'2026-10-18')));
  assert.equal(calls,1);assert.ok(rs.every(r=>r.status==='available'));
  await service.get({country:'CN'},'2026-10-18');assert.equal(calls,1);
  assert.equal((await service.get({country:'JP'},'2026-10-18')).status,'unsupported');
});
test('weather uses six-digit administrative adcode, never transit telephone citycode',async()=>{
  const code=await weatherAdcode({lat:31.2,lng:121.4,country:'CN'},async path=>{
    assert.equal(path,'v3/geocode/regeo');return {regeocode:{addressComponent:{citycode:'021',adcode:'310101'}}};
  });assert.equal(code,'310101');
  assert.equal(await weatherAdcode({adcode:'310000'},()=>{throw Error('unneeded');}),'310000');
});
test('official alerts suppress expired, cancelled and superseded events; endpoint and credential stay bounded',async()=>{
  const base={issuedTime:'2026-10-18T06:00:00Z',effectiveTime:'2026-10-18T07:00:00Z',expireTime:'2026-10-18T10:00:00Z',urgency:'immediate',severity:'severe',headline:'暴雨预警',senderName:'示例气象台',description:'测试资料',instruction:'留意官方通知'};
  const raw={metadata:{zeroResult:false,attributions:['数据来自测试替身']},alerts:[
    {...base,id:'old',messageType:{code:'alert'}},{...base,id:'new',messageType:{code:'update',supersedes:['old']}},
    {...base,id:'cancel',messageType:{code:'cancel',supersedes:['new']}},
    {...base,id:'expired',expireTime:'2026-10-18T01:00:00Z'},
    {...base,id:'active',messageType:{code:'alert'}},
  ]};
  assert.deepEqual(normalizeAlerts(raw,now).items.map(x=>x.id),['active']);
  let calls=0;const get=createWeatherAlerts({env:{QWEATHER_API_HOST:'example.qweatherapi.com',QWEATHER_API_KEY:'fixture-only'},now:()=>now,requestJSON:async(provider,url,options)=>{
    calls++;assert.equal(provider,'QWeather');assert.match(url,/\/weatheralert\/v1\/current\/31\.20\/121\.40\?lang=zh$/);assert.ok(!url.includes('fixture-only'));
    assert.equal(options.headers['X-QW-Api-Key'],'fixture-only');return raw;
  }});
  assert.equal((await get({lat:31.2,lng:121.4})).items.length,1);assert.equal(calls,1);
  await assert.rejects(createWeatherAlerts({env:{QWEATHER_API_HOST:'evil.example',QWEATHER_API_KEY:'fixture-only'}})({lat:31,lng:121}),/主机/);
  assert.equal((await createWeatherAlerts({env:{}})({})).status,'not_configured');
});
