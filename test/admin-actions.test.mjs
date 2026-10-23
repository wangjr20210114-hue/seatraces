/* 验证后台操作校验与执行。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {adminActions} from '../server/operations/action-definitions.mjs';
import {prepareAdminAction,createAdminActionRunner} from '../server/operations/action-runner.mjs';
import {routePermission} from '../server/operations/permissions.mjs';
import {iterationFixture} from './helpers/iteration-db.mjs';
test('registered action rules are the HTTP permission source; absent authority fails closed',()=>{
 for(const d of Object.values(adminActions))assert.equal(routePermission(d.method,d.path.replace(':id',randomUUID())),d.permission);
 const req={method:'PATCH',params:{id:randomUUID()},body:{disabled:true,reason:'support'},user:{id:randomUUID()}};
 assert.throws(()=>prepareAdminAction(req,'user.status'),{status:403});
 assert.throws(()=>prepareAdminAction({...req,adminAccess:{permissions:['*']}},'unknown'),{status:403});
 assert.throws(()=>prepareAdminAction({...req,method:'GET',adminAccess:{permissions:['*']}},'user.status'),{status:403});
});
test('shared admin action transaction, no-op replay and current permission check',{skip:process.env.TEST_OPERATIONS!=='1'},async t=>{
 const f=await iterationFixture();try{await f.start();const url='/api/admin/users/'+f.users.user.id+'/status',body={disabled:true,reason:'security'};
  await t.test('20 repeated disable requests produce one state transition and one audit',async()=>{
   const r=await Promise.all(Array.from({length:20},()=>f.request(url,{method:'PATCH',body})));assert.ok(r.every(x=>x.status===200));
   const audits=(await f.query("SELECT * FROM operation_events WHERE action='user.disable'")).rows;assert.equal(audits.length,1);assert.equal(audits[0].metadata.operation,'user.status');assert.ok(audits[0].request_id);
  });
  await t.test('audit error rolls back account state and resource constraints stay enforced',async()=>{
   const append=f.events.append;f.events.append=async()=>{throw Error('audit failure');};assert.equal((await f.request(url,{method:'PATCH',body:{...body,disabled:false}})).status,500);f.events.append=append;
   assert.ok((await f.query('SELECT disabled_at FROM users WHERE id=$1',[f.users.user.id])).rows[0].disabled_at);
   assert.equal((await f.request('/api/admin/users/'+f.users.admin.id+'/status',{method:'PATCH',body})).status,409);
  });
  await t.test('previously parsed authority cannot write after account disable',async()=>{
   const run=createAdminActionRunner(f);const req={method:'PATCH',params:{id:f.users.user.id},body,user:{id:f.users.admin.id},adminAccess:{permissions:['*'],version:0}};
   prepareAdminAction(req,'user.status');await f.query('UPDATE users SET disabled_at=now() WHERE id=$1',[f.users.admin.id]);let called=false;
   await assert.rejects(()=>run(req,'user.status',async()=>{called=true;return {value:{}};}),{status:403});assert.equal(called,false);
  });
 }finally{await f.close();}
});
