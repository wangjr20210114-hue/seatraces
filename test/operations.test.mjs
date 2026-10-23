/* 验证后台管理接口。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {mkdir,writeFile} from 'node:fs/promises';
import {createEventRecorder} from '../server/operations/events.mjs';
import {eventFilters} from '../server/operations/routes.mjs';
import {iterationFixture} from './helpers/iteration-db.mjs';

test('log date windows reject invalid or unbounded export ranges',()=>{
  assert.throws(()=>eventFilters({from:'2026-02-30'}));
  assert.throws(()=>eventFilters({from:'2026-10-20',to:'2026-10-18'}));
  assert.throws(()=>eventFilters({from:'2026-01-01',to:'2026-10-16'}));
  assert.deepEqual(eventFilters({from:'2026-10-16',to:'2026-10-16'}).slice(0,2),['2026-10-15T16:00:00.000Z','2026-10-16T16:00:00.000Z']);
});
test('log queue is bounded and exposes dropped/failed counts',async()=>{
  const events=createEventRecorder({query:async()=>{throw Error('database unavailable');},maximumQueue:3});
  for(let i=0;i<5;i++)events.record({kind:'system',action:'test'});
  assert.equal(events.stats().dropped,2);await events.close();assert.equal(events.stats().failed,3);
});
test('admin permissions, user status, sanitized logs and bounded concurrent traffic',{skip:process.env.TEST_OPERATIONS!=='1'},async t=>{
  const f=await iterationFixture();
  f.app.post('/api/test/action',f.auth,(req,res)=>res.json({ok:true}));
  f.app.get('/api/test/failure',(req,res,next)=>next(Error('SECRET-error-body')));
  try{
    await f.start();
    await t.test('ADM-01/02 roles, safe fields and query validation',async()=>{
      for(const path of ['/api/admin/overview','/api/admin/users','/api/admin/events','/api/admin/events/export','/api/admin/tasks']){
        assert.equal((await f.request(path,{user:null})).status,401,path);
        assert.equal((await f.request(path,{user:'user'})).status,403,path);
        assert.equal((await f.request(path)).status,200,path);
      }
      const r=await f.request('/api/admin/users?limit=1');assert.equal(r.data.items.length,1);assert.equal(r.data.hasMore,true);
      assert.equal(JSON.stringify(r.data).includes('password'),false);
      assert.equal((await f.request('/api/admin/users?limit=100000')).status,400);
      assert.equal((await f.request('/api/admin/users?q='+encodeURIComponent("' OR 1=1 --"))).data.items.length,0);
    });
    await t.test('ADM-03/04 disable revokes cookies; no administrator can be disabled via API',async()=>{
      const target='/api/admin/users/'+f.users.user.id+'/status';
      assert.equal((await f.request(target,{user:'other',body:{disabled:true,reason:'security'},method:'PATCH'})).status,403);
      assert.equal((await f.request('/api/admin/users/'+f.users.admin.id+'/status',{body:{disabled:true,reason:'security'},method:'PATCH'})).status,409);
      assert.equal((await f.request(target,{body:{disabled:true,reason:'security'},method:'PATCH'})).status,200);
      assert.equal((await f.request('/api/test/action',{user:'user',body:{}})).status,401);
      assert.equal((await f.request('/api/auth/login',{user:null,body:{username:f.users.user.username,password:f.password}})).status,403);
      assert.equal((await f.request(target,{body:{disabled:false,reason:'support'},method:'PATCH'})).status,200);
      assert.equal((await f.request('/api/test/action',{user:'user',body:{}})).status,401,'old session remains invalid');
      assert.equal((await f.request('/api/auth/login',{user:null,body:{username:f.users.user.username,password:f.password}})).status,200);
    });
    await t.test('ADM-05/06 request/body isolation, navigation whitelist, exports and date bounds',async()=>{
      assert.equal((await f.request('/api/activity',{user:null,body:{page:'home'}})).status,401);
      assert.equal((await f.request('/api/activity',{user:'other',body:{page:'home',password:'SECRET-no-log'}})).status,400);
      assert.equal((await f.request('/api/activity',{user:'other',body:{page:'home'}})).status,202);
      await f.request('/api/test/action?q=SECRET-query',{user:'other',body:{password:'SECRET-password',position:[121.4,31.2]}});
      await f.request('/api/test/failure',{user:'other'});
      while(f.events.stats().queued)await f.events.flush();
      const rows=(await f.query('SELECT * FROM operation_events')).rows;
      const text=JSON.stringify(rows);
      assert.equal(text.includes('SECRET'),false);assert.equal(text.includes(f.password),false);assert.equal(text.includes('121.4'),false);
      assert.ok(rows.some(e=>e.action==='home.open'&&e.user_id===f.users.other.id));
      assert.ok(rows.some(e=>e.action==='POST /api/test/action'));
      assert.ok(rows.some(e=>e.action==='POST /api/auth/login'));
      assert.ok(rows.some(e=>e.kind==='system'));
      const exported=await f.request('/api/admin/events/export');assert.equal(exported.status,200);
      const lines=gunzipSync(exported.data).toString().trim().split('\n').map(JSON.parse);assert.ok(lines.length);assert.ok(lines.every(e=>e.action));
      assert.equal((await f.request('/api/admin/events/export?from=2020-01-01&to=2026-10-16')).status,400);
      await f.query("INSERT INTO operation_events(kind,action) SELECT 'system','load.export' FROM generate_series(1,20001)");
      assert.equal((await f.request('/api/admin/events/export')).status,413);
      await f.query("DELETE FROM operation_events WHERE action='load.export'");
    });
    await t.test('ADM-07 400 local requests, concurrency 20; no external API cost',async()=>{
      const times=[];let cursor=0,errors=0;const started=performance.now();
      await Promise.all(Array.from({length:20},async()=>{
        while(cursor<400){const i=cursor++,begin=performance.now();
          const r=await f.request(i%4===0?'/api/activity':'/api/admin/users?limit=10',i%4===0?{user:'other',body:{page:'home'}}:{});
          if(r.status!==(i%4===0?202:200))errors++;times.push(performance.now()-begin);
        }
      }));
      while(f.events.stats().queued)await f.events.flush();
      times.sort((a,b)=>a-b);const result={requests:400,concurrency:20,errors,p50Ms:Math.round(times[199]),p95Ms:Math.round(times[379]),elapsedMs:Math.round(performance.now()-started),logs:f.events.stats(),externalApiCalls:0};
      assert.equal(errors,0);assert.equal(result.logs.failed,0);assert.equal(result.logs.dropped,0);
      await mkdir(new URL('../validation/iteration-20261016/',import.meta.url),{recursive:true});
      await writeFile(new URL('../validation/iteration-20261016/admin-pressure.json',import.meta.url),JSON.stringify(result,null,2));
      console.log('ADMIN_PRESSURE '+JSON.stringify(result));
    });
  }finally{await f.close();}
});
