import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installJourneyInsights,comparePlans,planSummary} from '../server/operations/journey-insights.mjs';
test('journey projection handles malformed snapshots and keeps duplicate occurrences in differences',()=>{
  assert.deepEqual(planSummary(null).days,[]);
  const before={origin:'PRIVATE_ADDRESS',days:[{stops:[{id:'a',name:'A',lat:12},{id:'a',name:'A',leave:'12:00'},{id:'b',name:'B'}]}]};
  const after={days:[{stops:[{id:'b',name:'B'},{id:'a',name:'A',locked:true},{id:'c',name:'C'}]}]};
  const d=comparePlans(before,after).days[0];assert.equal(d.removed.length,1);assert.equal(d.removed[0].id,'a');assert.equal(d.added[0].id,'c');assert.equal(d.reordered.length,2);assert.equal(d.changed.length,1);
  assert.ok(!JSON.stringify(planSummary(before)).includes('PRIVATE'));assert.ok(!JSON.stringify(planSummary(before)).includes('lat'));
  assert.equal(planSummary({days:Array.from({length:33},()=>({stops:Array(102).fill({})}))}).truncated,true);
});
test('journey administration uses stored snapshots, safe projections and scoped permissions',{skip:process.env.TEST_OPERATIONS!=='1'},async t=>{
  const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','citywalk-expansion-schema.sql']});installJourneyInsights(f.app,f);
  const id=randomUUID(),other=randomUUID(),walk=randomUUID(),a={days:[{city:'上海',date:'2026-10-20',stops:[{id:'a',name:'外滩',arrive:'09:00',duration_min:60},{id:'b',name:'博物馆'}]}]},b={...a,origin:'PRIVATE_ORIGIN',days:[{...a.days[0],stops:[{id:'b',name:'博物馆'},{id:'c',name:'公园'}]}]};
  try{
    await f.query("INSERT INTO trips(id,user_id,title,request,plan,version) VALUES($1,$2,'上海漫游',$3,$4,2)",[id,f.users.user.id,{cities:[{name:'上海',secret:'PRIVATE_CITY'}],start:'2026-10-20',end:'2026-10-21',origin:'PRIVATE_INPUT'},b]);
    await f.query("INSERT INTO trip_versions(trip_id,version,plan,reason) VALUES($1,1,$2,'PRIVATE_REASON')",[id,a]);
    await f.query("INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,'其他路线','{}','{}')",[other,f.users.other.id]);
    await f.query("INSERT INTO citywalks(id,user_id,title,city,stops,distance_m,verified_route) VALUES($1,$2,'滨江步行','{\"name\":\"上海\"}','[{\"name\":\"外滩\",\"lat\":12},{\"name\":\"公园\"}]',2900,'{\"status\":\"preview\",\"secret\":\"PRIVATE_PROVIDER\"}')",[walk,f.users.user.id]);
    await f.start();
    await t.test('JI01 filter and details preserve actual version semantics without private coordinates',async()=>{
      let v=(await f.request('/api/admin/journeys?userId='+f.users.user.id)).data;assert.equal(v.items.length,1);assert.deepEqual(v.items[0].cities,['上海']);
      v=(await f.request('/api/admin/journeys/trips/'+id+'?version=1')).data;assert.equal(v.selectedVersion,1);assert.equal(v.trip.currentVersion,2);assert.equal(v.plan.days[0].stops[0].name,'外滩');assert.equal(v.versions.length,2);assert.ok(!JSON.stringify(v).includes('PRIVATE'));assert.ok(!JSON.stringify(v).includes('latitude'));
      const current=(await f.request('/api/admin/journeys/trips/'+id)).data;assert.equal(current.plan.days[0].stops[0].name,'博物馆');
      assert.equal((await f.request('/api/admin/journeys/trips/'+id+'?version=8')).status,404);assert.equal((await f.request('/api/admin/journeys/trips/'+other+'?version=2')).status,404);
    });
    await t.test('JI02 comparison and CityWalk distinguish verified distance from preview; no invented history',async()=>{
      const d=(await f.request('/api/admin/journeys/trips/'+id+'/compare?fromVersion=1&toVersion=2')).data;
      assert.equal(d.days[0].added[0].name,'公园');assert.equal(d.days[0].removed[0].name,'外滩');assert.equal(d.days[0].reordered[0].id,'b');
      const w=(await f.request('/api/admin/journeys/citywalks/'+walk)).data;assert.equal(w.historyAvailable,false);assert.equal(w.distanceDefinition,'unverified_saved_distance');assert.ok(!JSON.stringify(w).includes('PRIVATE'));assert.ok(!JSON.stringify(w).includes('lat'));
      assert.equal((await f.request('/api/admin/journeys?kind=citywalk&state=unverified')).data.items.length,1);
      assert.equal((await f.request('/api/admin/journeys?kind=citywalk&state=planned')).status,400);
      assert.equal((await f.request('/api/admin/journeys?from=2026-10-01&to=2026-01-01')).status,400);
    });
    await t.test('JI03 anonymous/user/analyst denied, support permitted, every detail read audited',async()=>{
      const path='/api/admin/journeys/trips/'+id;assert.equal((await f.request(path,{user:null})).status,401);assert.equal((await f.request(path,{user:'user'})).status,403);
      let n=0;for(const role of ['analyst','support']){await f.request('/api/admin/access/members/'+f.users.other.id,{method:'PUT',body:{role,version:n++,confirmation:'change-role'}});const login=await f.request('/api/auth/admin/login',{user:null,body:{username:f.users.other.username,password:f.password}});const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');assert.equal((await f.request(path,{headers:{Cookie:cookie}})).status,role==='support'?200:403);}
      assert.ok((await f.query("SELECT count(*)::int n FROM operation_events WHERE action='journey.trip_read'")).rows[0].n>=3);
    });
    await t.test('JI04 pressure: 120 detail and compare calls, concurrency 8',async()=>{
      let n=0;const ms=[];await Promise.all(Array.from({length:8},async()=>{while(n<120){const i=n++,start=performance.now(),v=await f.request('/api/admin/journeys/trips/'+id+(i%2?'/compare?fromVersion=1&toVersion=2':''));assert.equal(v.status,200);ms.push(performance.now()-start);}}));ms.sort((a,b)=>a-b);console.log('PRESSURE journey: 120 requests/concurrency 8, p95='+Math.round(ms[114])+'ms');
    });
  }finally{await f.close();}
});
