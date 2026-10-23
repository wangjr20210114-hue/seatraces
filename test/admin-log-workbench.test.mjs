/* 验证日志筛选与查询视图。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {eventQuery,eventFilters} from '../server/operations/event-query.mjs';
import {readLogLocation} from '../public/admin-log-explorer.js';
test('log query rejects arbitrary fields and binds literal searches',()=>{
  const q=eventQuery({action:"%' OR 1=1 --",actor:'a_b',sort:'duration_ms',minDuration:0});
  assert.ok(!q.where.includes('OR 1=1'));assert.ok(q.values.includes("%\\%' OR 1=1 --%"));assert.ok(q.values.includes('%a\\_b%'));
  for(const input of [{sort:'password_hash'},{order:'desc;drop'},{minDuration:-1},{requestId:'bad'},{outcome:'maybe'},{from:'2026-10-17',to:'2026-10-16'}])assert.throws(()=>eventQuery(input));
  assert.equal(eventFilters({from:'2026-10-17',to:'2026-10-17'})[0],'2026-10-16T16:00:00.000Z');
  assert.deepEqual(readLogLocation('#/events?actor=test&columns=kind,secret,kind&offset=-1'),{filters:{actor:'test'},columns:['kind'],offset:0});
});
test('log workbench filters, private views, conflicts and concurrency',{skip:process.env.TEST_OPERATIONS!=='1',timeout:60000},async t=>{
 const f=await iterationFixture();const viewId=randomUUID(),root='/api/admin/events';
 try{
  await f.query("INSERT INTO operation_events(user_id,kind,action,status,duration_ms,request_id,resource_id) VALUES($1,'request','fixture.journey',503,1800,$2,'trip-one'),($1,'request','fixture.journey',200,100,$2,'trip-two'),($1,'navigation','fixture.open',NULL,NULL,NULL,NULL),($1,'system','fixture.error',NULL,NULL,NULL,NULL)",[f.users.user.id,viewId]);await f.start();
  await t.test('combined filters, success semantics, stable sort and original response shape',async()=>{
   const r=await f.request(root+'?actor=fixture_user&action=fixture.&outcome=failure');assert.equal(r.status,200);assert.equal(r.data.items.length,2);assert.equal(typeof r.data.hasMore,'boolean');
   const slow=await f.request(root+'?action=fixture.&minDuration=1000&requestId='+viewId);assert.equal(slow.data.items.length,1);assert.equal(slow.data.items[0].resource_id,'trip-one');
   assert.equal((await f.request(root+'?action=fixture.&outcome=success')).data.items.length,1);
   assert.deepEqual((await f.request(root+'?action=fixture.&sort=duration_ms&order=asc')).data.items.slice(0,2).map(r=>r.duration_ms),[100,1800]);
   assert.equal((await f.request(root+'?action=%25')).data.items.length,0);
   assert.equal((await f.request(root+'?sort=sql')).status,400);
  });
  const body={id:viewId,name:'行程故障',filters:{action:'fixture.',outcome:'failure'},columns:['created_at','action']};let saved;
  await t.test('views require admin session, validate fields and persist only preferences',async()=>{
   assert.equal((await f.request(root+'/views',{user:null})).status,401);assert.equal((await f.request(root+'/views',{user:'user'})).status,403);
   assert.equal((await f.request(root+'/views/'+viewId,{method:'PUT',body:{...body,filters:{password:'secret'}}})).status,400);
   assert.equal((await f.request(root+'/views/'+viewId,{method:'PUT',body:{...body,columns:['password_hash']}})).status,400);
   const r=await f.request(root+'/views/'+viewId,{method:'PUT',body});assert.equal(r.status,200);saved=r.data;
   assert.equal((await f.request(root+'/views')).data.items[0].name,body.name);
  });
  await t.test('concurrent edits use optimistic locking; duplicate names and wrong owner rejected',async()=>{
   const results=await Promise.all(Array.from({length:8},()=>f.request(root+'/views/'+viewId,{method:'PUT',body:{...body,version:saved.version}})));
   assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,7);saved=results.find(r=>r.status===200).data;
   const duplicate=randomUUID();assert.equal((await f.request(root+'/views/'+duplicate,{method:'PUT',body:{...body,id:duplicate}})).status,409);
   await f.query("UPDATE users SET role='admin' WHERE id=$1",[f.users.other.id]);
   const login=await f.request('/api/auth/admin/login',{user:'other',body:{username:f.users.other.username,password:f.password}});assert.equal(login.status,200);f.users.other.cookie=login.headers.get('set-cookie').split(';')[0];
   assert.equal((await f.request(root+'/views',{user:'other'})).data.items.length,0);
   assert.equal((await f.request(root+'/views/'+viewId,{user:'other',method:'PUT',body:{...body,version:saved.version}})).status,404);
   assert.equal((await f.request(root+'/views/'+viewId,{user:'other',method:'DELETE',body:{version:saved.version,confirmation:'delete-view'}})).status,404);
  });
  await t.test('200 requests / 12 clients keep filters isolated',async()=>{
   let cursor=0;const times=[];await Promise.all(Array.from({length:12},async()=>{while(cursor++<200){const begin=performance.now(),r=await f.request(root+'?action=fixture.&resourceId=trip-one');assert.equal(r.status,200);assert.equal(r.data.items.length,1);times.push(performance.now()-begin);}}));times.sort((a,b)=>a-b);console.log('LOG_WORKBENCH_PRESSURE '+JSON.stringify({requests:200,concurrency:12,errors:0,p95Ms:Math.round(times[189])}));
  });
  await t.test('audit failure rolls back view deletion; successful removal preserves source logs',async()=>{
   const append=f.events.append;f.events.append=async()=>{throw Error('audit down');};
   const request={method:'DELETE',body:{version:saved.version,confirmation:'delete-view'}};
   assert.equal((await f.request(root+'/views/'+viewId,request)).status,500);f.events.append=append;
   assert.equal((await f.request(root+'/views')).data.items.length,1);assert.equal((await f.request(root+'/views/'+viewId,request)).status,200);
   assert.equal((await f.request(root+'?action=fixture.')).data.items.length,4);
  });
 }finally{await f.close();}
});
