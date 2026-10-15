import test from 'node:test';
import assert from 'node:assert/strict';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installClassicWalkRoutes,seedClassicWalks} from '../server/services/classic-citywalks.mjs';
import {createWalkingRouter,walkDistanceState} from '../server/services/citywalk-routing.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
test('CityWalk distance boundaries use raw walking metres',()=>{
  for(const [m,warning,blocked] of [[9999,false,false],[10000,false,false],[10001,true,false],[14999,true,false],[15000,true,true],[15001,true,true]])assert.deepEqual(walkDistanceState(m),{verified:true,warning,blocked});
  for(const v of [null,NaN,Infinity,-1])assert.equal(walkDistanceState(v).verified,false);
});
test('classic route management, cached walking geometry and publication',{skip:process.env.TEST_CITYWALK!=='1'},async t=>{
  const f=await iterationFixture({schemas:['citywalk-schema.sql','citywalk-expansion-schema.sql']});
  let calls=0,available=true,meters=900;
  const provider=async(a,b)=>{calls++;if(!available)throw Error('upstream failed');return {status:'live',mapProvider:'amap',checkedAt:'2026-10-16T00:00:00Z',alternatives:[{distanceMeters:meters,durationSeconds:600,segments:[{mapPolyline:[[121,31],[121.001,31.001]]}]}]};};
  const routing=createWalkingRouter({query:f.query,route:provider});
  const points=[{id:'p1',name:'博物馆',category:'attraction',lat:31,lng:121,country:'CN'},{id:'p2',name:'餐厅',category:'food',lat:31.001,lng:121.001,country:'CN'}];
  const form={id:'fixture-classic',title:'测试路线',cityId:'city1',stopIds:['p1','p2'],sources:[{title:'官方资料',url:'https://example.test/official',checkedAt:'2026-10-16'}],enabled:true};
  try{
    await f.query("CREATE TABLE places(id text PRIMARY KEY,name text,category text,country text,province text,lat double precision,lng double precision,timezone text);INSERT INTO places VALUES('city1','测试城','city','CN','测试',31,121,'Asia/Shanghai')");
    installClassicWalkRoutes(f.app,{auth:f.auth,query:f.query,transaction:f.transaction,events:f.events,verify:routing.verify,resolve:async id=>points.find(p=>p.id===id),search:async()=>({status:'live',items:points})});await f.start();
    await t.test('CW-01 classic seed is idempotent and never overwrites edits',async()=>{
      await seedClassicWalks(f.query);assert.equal((await f.request('/api/citywalk/classics')).data.items.length,3);
      await f.query("UPDATE classic_citywalks SET enabled=false,title='人工调整' WHERE id='beijing-hutong'");await seedClassicWalks(f.query);
      assert.equal((await f.query("SELECT title FROM classic_citywalks WHERE id='beijing-hutong'")).rows[0].title,'人工调整');
      assert.equal((await f.request('/api/citywalk/classics/beijing-hutong')).status,404);
    });
    await t.test('admin checks, input validation and immutable source resolution',async()=>{
      assert.equal((await f.request('/api/admin/citywalks',{user:'user',body:form})).status,403);
      assert.equal((await f.request('/api/admin/citywalks',{user:null,body:form})).status,401);
      assert.equal((await f.request('/api/admin/citywalks',{body:{...form,sources:[{...form.sources[0],url:'javascript:alert(1)'}]}})).status,400);
      assert.equal((await f.request('/api/admin/citywalks',{body:{...form,stopIds:['p1','p1']}})).status,400);
      assert.equal((await f.request('/api/admin/citywalks',{body:{...form,stopIds:['p1','invented']}})).status,400);
      const r=await f.request('/api/admin/citywalks',{body:form});assert.equal(r.status,200);assert.equal(r.data.route.distanceM,900);assert.equal(r.data.stops[0].name,'博物馆');
      assert.equal((await f.request('/api/admin/citywalks',{body:form})).status,409);
      assert.equal((await f.request('/api/admin/citywalks/'+form.id,{method:'PUT',body:{...form,version:999}})).status,409);
      assert.equal((await f.request('/api/admin/citywalks/'+form.id+'/visibility',{method:'PATCH',body:{enabled:false,version:1}})).status,200);
      assert.equal((await f.request('/api/citywalk/classics/'+form.id)).status,404);
    });
    await t.test('verified legs reuse PostgreSQL cache; estimated routes never count as actual',async()=>{
      calls=0;await f.query('DELETE FROM citywalk_route_legs');
      const outputs=await Promise.all(Array.from({length:20},()=>routing.verify(points)));assert.equal(calls,1);assert.ok(outputs.every(r=>r.status==='verified'&&r.distanceM===900));
      await routing.verify(points);assert.equal(calls,1);
      available=false;const other=points.map(p=>({...p,id:p.id+'x'}));const preview=await routing.verify(other);assert.equal(preview.status,'preview');assert.equal(preview.distanceM,null);assert.ok(preview.estimatedDistanceM>0);
      const currentCalls=calls;await routing.verify(other);assert.equal(calls,currentCalls,'failed calls cool down');available=true;
      await f.query('DELETE FROM citywalk_route_legs');meters=15000;
      assert.equal((await f.request('/api/admin/citywalks',{body:{...form,id:'too-long'}})).status,422);
      assert.equal((await f.request('/api/admin/citywalks',{body:{...form,id:'draft-long',enabled:false}})).status,200);
    });
    await t.test('200 concurrent catalogue reads do not call external APIs',async()=>{
      let cursor=0,errors=0;const before=calls,start=performance.now(),times=[];
      await Promise.all(Array.from({length:20},async()=>{while(cursor++<200){const t=performance.now(),r=await f.request('/api/citywalk/classics');if(r.status!==200||r.data.items.length!==2)errors++;times.push(performance.now()-t);}}));
      assert.equal(errors,0);assert.equal(calls,before);times.sort((a,b)=>a-b);const result={requests:200,concurrency:20,errors,p50Ms:Math.round(times[99]),p95Ms:Math.round(times[189]),elapsedMs:Math.round(performance.now()-start),externalCalls:0};
      await mkdir(new URL('../validation/iteration-20261016/',import.meta.url),{recursive:true});await writeFile(new URL('../validation/iteration-20261016/classic-pressure.json',import.meta.url),JSON.stringify(result,null,2));console.log('CLASSIC_PRESSURE '+JSON.stringify(result));
    });
  }finally{await f.close();}
});
