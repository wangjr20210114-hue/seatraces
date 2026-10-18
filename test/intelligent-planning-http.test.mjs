import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installIntelligentPlanning,parseLocalEdit} from '../server/services/intelligent-planning.mjs';
import {tripMutationHandler} from '../server/services/trip-mutations.mjs';
test('complex edit ambiguity produces bounded choices instead of guessing',()=>{
 const stops=[{id:'a',name:'上海博物馆'},{id:'b',name:'历史博物馆'}];
 assert.equal(parseLocalEdit('这个博物馆不想去了，换个附近的',{stops}).choices.length,2);
 assert.deepEqual(parseLocalEdit('保留上海博物馆，其余重新安排，五点前结束',{stops}).input.keepIds,['a']);
});
test('owned verified previews use normal versioned mutation and support undo without changing other days',
 {skip:process.env.TEST_INTELLIGENT_PLANNING!=='1',timeout:60000},async()=>{
 const f=await iterationFixture({schemas:['schema.sql','social/style-schema.sql','planning-previews-schema.sql']});
 try{
  const id=randomUUID(),stops=Array.from({length:4},(_,i)=>({id:'p'+i,name:'景点'+i,category:'attraction',city:'上海',lat:31.2+i*.001,lng:121.4,
   arrive:['09:00','11:00','14:00','16:00'][i],leave:['10:30','12:00','15:30','17:00'][i],duration_min:60}));
  const plan={schemaVersion:'journey/2',cities:[{id:'sh',name:'上海'}],days:[{city:'上海',cityId:'sh',date:'2027-06-20',stops,timeBudget:{start:540,end:1080,transitionMinutes:8,mealMinutes:45}},
   {city:'上海',date:'2027-06-21',stops:[{...stops[0],id:'other-day'}]}]};
  await f.query("INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,'局部修改',$3,$4)",[id,f.users.user.id,{pace:'balanced',transport:'balanced',revisit:'either'},plan]);
  await f.query("INSERT INTO trip_versions(trip_id,version,plan,reason) VALUES($1,1,$2,'初始')",[id,plan]);
  const service=installIntelligentPlanning(f.app,{auth:f.auth,query:f.query,transaction:f.transaction,loadCandidates:async()=>stops,
   opening:async()=>null,routeLeg:async()=>({status:'live',minutes:6,walkingMeters:100})});
  const ownTrip=async(id,user,c,lock)=>(await c.query('SELECT * FROM trips WHERE id=$1 AND user_id=$2'+(lock?' FOR UPDATE':''),[id,user])).rows[0]||(()=>{throw Object.assign(Error('missing'),{status:404});})();
  f.app.patch('/api/trips/:id',f.auth,tripMutationHandler({transaction:f.transaction,ownTrip,applyPreview:service.apply}));
  await f.start();const path='/api/journey/trips/'+id,body={version:1,day:0,afternoonOnly:true,removeCount:1,focus:'walk'};
  assert.equal((await f.request(path+'/alternatives',{user:null,body})).status,401);
  assert.equal((await f.request(path+'/alternatives',{user:'other',body})).status,404);
  assert.equal((await f.request(path+'/alternatives',{user:'user',body:{...body,version:2}})).status,409);
  const r=await f.request(path+'/alternatives',{user:'user',body});assert.equal(r.status,200);assert.equal(r.data.items.length,1);
  const pid=r.data.items[0].id,operation={type:'apply_preview',day:0,previewId:pid},patch={version:1,operation};
  assert.equal((await f.request('/api/trips/'+id,{user:'user',method:'PATCH',body:patch})).status,409);
  assert.equal((await f.request(path+'/alternatives/'+pid+'/verify',{user:'other',body:{version:1}})).status,404);
  const v=await f.request(path+'/alternatives/'+pid+'/verify',{user:'user',body:{version:1}});assert.equal(v.data.verification,'verified');
  const saved=await Promise.all(Array.from({length:12},()=>f.request('/api/trips/'+id,{user:'user',method:'PATCH',body:patch})));
  assert.equal(saved.filter(x=>x.status===200).length,1);assert.equal(saved.filter(x=>x.status===409).length,11);
  const t=saved.find(x=>x.status===200).data;assert.equal(t.version,2);assert.equal(t.plan.days[0].stops.length,3);
  assert.deepEqual(t.plan.days[0].stops.slice(0,2),plan.days[0].stops.slice(0,2));assert.deepEqual(t.plan.days[1],plan.days[1]);
  const undo=await f.request('/api/trips/'+id,{user:'user',method:'PATCH',body:{version:2,restoreVersion:1}});
  assert.equal(undo.data.version,3);assert.deepEqual(undo.data.plan,plan);
  const assist=await f.request('/api/trips/'+id+'/assistant',{user:'user',body:{day:0,text:'下午太累了，少安排一个地方'}});
  assert.equal(assist.data.status,'preview');assert.equal(assist.data.operation.type,'apply_preview');
  const records=(await f.query('SELECT count(*)::int n FROM trip_plan_previews WHERE user_id=$1',[f.users.user.id])).rows[0].n;assert.ok(records<=8);
  await f.query("UPDATE trip_plan_previews SET expires_at=now()-interval '1 minute' WHERE id=$1",[assist.data.operation.previewId]);
  assert.equal((await f.request('/api/trips/'+id,{user:'user',method:'PATCH',body:{version:3,operation:assist.data.operation}})).status,410);
 }finally{await f.close();}
});
