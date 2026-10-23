/* 验证游客访问范围。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {guestPage,guestApiRead,guestMapStyle} from '../public/guest-policy.js';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installClassicWalkRoutes,seedClassicWalks} from '../server/services/classic-citywalks.mjs';
test('guest surface is a narrow read-only allowlist',()=>{
  assert.ok(guestPage({page:'home'}));assert.ok(guestPage({page:'citywalk',id:'classic-hangzhou-lake'}));
  for(const page of ['agent','discover','profile','history','services','settings','account'])assert.equal(guestPage({page}),false);
  for(const id of ['new','other-id','classic-../../admin','classic-'])assert.equal(guestPage({page:'citywalk',id}),false);
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal(guestApiRead('/citywalk/classics',method),false);
  assert.equal(guestApiRead('/citywalk/classics/foo/stops'),false);
  assert.equal(guestMapStyle('/v3/place/text'),false);assert.equal(guestMapStyle('/v4/map/styles','POST'),false);
});
test('guest HTTP reads neither persist user data nor add personal trails',{skip:process.env.TEST_GUEST!=='1',timeout:30000},async t=>{
  const f=await iterationFixture({schemas:['citywalk-schema.sql','citywalk-expansion-schema.sql']});
  try{
    await seedClassicWalks(f.query);
    installClassicWalkRoutes(f.app,{...f});
    f.app.get('/api/maps/config',(req,res)=>res.json({enabled:false,jsKey:null}));
    f.app.get('/api/_AMapService/v4/map/styles',(req,res)=>res.json({ok:true}));
    f.app.get('/api/guest-protected',(req,res)=>res.json({unexpected:true}));
    await f.start();
    const counts=async()=>{const r={};for(const table of ['users','sessions','citywalks','citywalk_drafts','operation_events'])r[table]=(await f.query('SELECT count(*)::int n FROM '+table)).rows[0].n;return r;};
    const before=await counts();
    assert.equal((await f.request('/api/me',{user:null})).data.user,null);
    assert.equal((await f.request('/api/maps/config',{user:null})).status,200);
    assert.equal((await f.request('/api/_AMapService/v4/map/styles',{user:null})).status,200);
    assert.equal((await f.request('/api/citywalk/classics',{user:null})).status,200);
    assert.equal((await f.request('/api/citywalk/classics/hangzhou-lake',{user:null})).status,200);
    for(const path of ['/api/guest-protected','/api/admin/users','/api/inbox','/api/citywalks','/api/agent/threads','/api/posts','/api/catalog/search','/api/maps/google/config'])assert.equal((await f.request(path,{user:null})).status,401,path);
    for(const path of ['/api/citywalks','/api/citywalk/preview','/api/journey/sessions','/api/activity','/api/citywalk/classics'])assert.equal((await f.request(path,{user:null,body:{}})).status,401,path);
    const times=[],start=performance.now();let errors=0;
    for(let b=0;b<10;b++)await Promise.all(Array.from({length:20},async()=>{const t=performance.now(),r=await f.request('/api/citywalk/classics',{user:null});times.push(performance.now()-t);if(r.status!==200)errors++;}));
    await f.events.flush();assert.deepEqual(await counts(),before);assert.equal(errors,0);times.sort((a,b)=>a-b);
    t.diagnostic(JSON.stringify({requests:200,concurrency:20,errors,p50:Math.round(times[100]),p95:Math.round(times[190]),elapsedMs:Math.round(performance.now()-start),persistedPersonalRows:0,paidCalls:0}));
  }finally{await f.close();}
});
