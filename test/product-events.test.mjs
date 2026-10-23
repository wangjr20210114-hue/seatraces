/* 验证业务事件记录。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {trackedMutation} from '../server/operations/request-context.mjs';
test('only tracked business writes need transaction correlation',()=>{
  assert.equal(trackedMutation('SELECT * FROM trips'),false);
  assert.equal(trackedMutation('UPDATE trips SET version=2'),true);
  assert.equal(trackedMutation('INSERT INTO citywalks(id) VALUES($1)'),true);
  assert.equal(trackedMutation('UPDATE places SET name=$1'),false);
});
test('business events are transactional, correlated, replay safe and free of sensitive payloads',{skip:process.env.TEST_OPERATIONS!=='1'},async t=>{
  const schemas=['schema.sql','citywalk-schema.sql','agent/schema.sql','operations/inbox-schema.sql','citywalk-expansion-schema.sql','operations/product-schema.sql'];
  const f=await iterationFixture({schemas});
  const insert=async(db,id,owner)=>db.query(`INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,'PRIVATE_TITLE','{"origin":{"label":"PRIVATE_ORIGIN","lat":31.123456}}','{"days":[{"stops":[]}]}') ON CONFLICT(id) DO NOTHING`,[id,owner]);
  f.app.post('/api/test/business',f.auth,async(req,res)=>{
    await f.transaction(async c=>{await insert(c,req.body.id,req.user.id);if(req.body.rollback)throw Object.assign(Error('rollback'),{status:409});});res.json({ok:true});
  });
  f.app.post('/api/journey/sessions/:id/generate',f.auth,async(req,res)=>{
    const s=(await f.query('SELECT id FROM journey_sessions WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id])).rows[0];
    if(!s)return res.status(404).json({error:'not found'});
    await f.transaction(async c=>{await insert(c,req.body.tripId,req.user.id);await c.query('UPDATE journey_sessions SET trip_id=$2 WHERE id=$1',[s.id,req.body.tripId]);});res.json({ok:true});
  });
  try{
    await f.start();
    await t.test('EVT01 rollback removes both business write and event',async()=>{
      const id=randomUUID();assert.equal((await f.request('/api/test/business',{user:'user',body:{id,rollback:true}})).status,409);
      assert.equal((await f.query('SELECT 1 FROM trips WHERE id=$1',[id])).rowCount,0);
      assert.equal((await f.query('SELECT 1 FROM product_events WHERE resource_id=$1',[id])).rowCount,0);
    });
    await t.test('EVT02 20 concurrent retries produce one successful creation event',async()=>{
      const id=randomUUID();await Promise.all(Array.from({length:20},async()=>assert.equal((await f.request('/api/test/business',{user:'user',body:{id},headers:{'X-Request-Id':'forged-id'}})).status,200)));
      const rows=(await f.query('SELECT * FROM product_events WHERE resource_id=$1',[id])).rows;assert.equal(rows.length,1);assert.equal(rows[0].user_id,f.users.user.id);assert.equal(rows[0].event_type,'trip.saved');assert.match(rows[0].request_id,/^[\da-f-]{36}$/);
      assert.ok(!JSON.stringify(rows).includes('PRIVATE'));assert.ok(!JSON.stringify(rows).includes('31.123456'));
      await f.query('UPDATE trips SET updated_at=now() WHERE id=$1',[id]);assert.equal((await f.query('SELECT 1 FROM product_events WHERE resource_id=$1',[id])).rowCount,1);
    });
    await t.test('EVT03 questionnaire, trip and completion link to the same owned flow',async()=>{
      const flow=randomUUID(),tripId=randomUUID();await f.query("INSERT INTO journey_sessions(id,user_id,request) VALUES($1,$2,'{}')",[flow,f.users.user.id]);
      await f.query("UPDATE journey_sessions SET catalog='{\"city\":{}}' WHERE id=$1",[flow]);
      await f.query("UPDATE journey_sessions SET questions='{\"questions\":[]}' WHERE id=$1",[flow]);
      assert.equal((await f.request('/api/journey/sessions/'+flow+'/generate',{user:'other',body:{tripId}})).status,404);
      const r=await f.request('/api/journey/sessions/'+flow+'/generate',{user:'user',body:{tripId}});assert.equal(r.status,200);
      const rows=(await f.query('SELECT event_type,request_id FROM product_events WHERE flow_id=$1 ORDER BY created_at',[flow])).rows;
      assert.deepEqual(rows.map(e=>e.event_type),['journey.started','journey.candidates_loaded','journey.questions_ready','trip.saved','journey.completed']);
      assert.equal(rows[3].request_id,r.headers.get('x-request-id'));assert.equal(rows[4].request_id,rows[3].request_id);
      const outside=randomUUID();await insert(f,outside,f.users.other.id);
      assert.equal((await f.query('SELECT request_id FROM product_events WHERE resource_id=$1',[outside])).rows[0].request_id,null,'pooled connection must not leak previous context');
    });
    await t.test('EVT04 memory/action/walk events store only defined summaries and migration is idempotent',async()=>{
      const owner=f.users.user.id,conversation=randomUUID(),action=randomUUID(),walk=randomUUID(),draft=randomUUID();
      await f.query("INSERT INTO user_travel_memory(user_id,dimension,value,strength,confidence,evidence,source) VALUES($1,'pace','\"relaxed\"',0.2,1,'PRIVATE_EVIDENCE','user_confirmed')",[owner]);
      await f.query("INSERT INTO agent_conversations(id,user_id,state) VALUES($1,$2,'{}')",[conversation,owner]);
      await f.query("INSERT INTO agent_actions(id,conversation_id,user_id,capability,payload,preview,status) VALUES($1,$2,$3,'trip.edit','{\"secret\":\"PRIVATE_TOOL\"}','{}','pending')",[action,conversation,owner]);
      await f.query("UPDATE agent_actions SET status='completed',result='{\"secret\":\"PRIVATE_RESULT\"}' WHERE id=$1",[action]);
      await f.query("INSERT INTO citywalk_drafts(id,user_id,city,catalog) VALUES($1,$2,'{}','{}')",[draft,owner]);
      await f.query("INSERT INTO citywalks(id,user_id,title,city,stops,distance_m,verified_route) VALUES($1,$2,'PRIVATE_WALK','{}','[{},{}]',1200,'{\"status\":\"verified\"}')",[walk,owner]);
      await f.query("UPDATE citywalks SET version=2,stops='[{},{},{}]' WHERE id=$1",[walk]);
      const rows=(await f.query('SELECT event_type,properties FROM product_events')).rows;
      for(const type of ['memory.confirmed','agent.action_prepared','agent.action_completed','citywalk.started','citywalk.saved','citywalk.updated'])assert.ok(rows.some(r=>r.event_type===type),type);
      assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
      const before=(await f.query('SELECT count(*)::int n FROM product_events')).rows[0].n;
      await f.query(await readFile(new URL('../server/operations/product-schema.sql',import.meta.url),'utf8'));
      assert.equal((await f.query('SELECT count(*)::int n FROM product_events')).rows[0].n,before);
    });
    await t.test('EVT05 120 writes, concurrency 8, exact request/user association and no guest trail',async()=>{
      let index=0;await Promise.all(Array.from({length:8},async()=>{while(index<120){const n=index++,actor=n%2?'user':'other',id=randomUUID();const r=await f.request('/api/test/business',{user:actor,body:{id}});assert.equal(r.status,200);const e=(await f.query('SELECT user_id,request_id FROM product_events WHERE resource_id=$1',[id])).rows[0];assert.equal(e.user_id,f.users[actor].id);assert.equal(e.request_id,r.headers.get('x-request-id'));}}));
      const before=(await f.query('SELECT count(*)::int n FROM product_events')).rows[0].n;
      assert.equal((await f.request('/api/test/business',{user:null,body:{id:randomUUID()}})).status,401);
      assert.equal((await f.query('SELECT count(*)::int n FROM product_events')).rows[0].n,before);
    });
  }finally{await f.close();}
});
