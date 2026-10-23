/* 验证AI 会话管理查询。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installAgentInsights,turnSummary} from '../server/operations/agent-insights.mjs';
import {createApiBridge} from '../server/agent/bridge.mjs';
import {createAgentStore} from '../server/agent/store.mjs';
test('trace summary is an allowlisted projection, not a raw dialogue dump',()=>{
  const t=turnSummary({id:randomUUID(),response:{text:'PRIVATE_ANSWER',input:'PRIVATE_INPUT',payload:{key:'PRIVATE_KEY'},intent:'invented',classification:{source:'invented',confidence:999,evidence:'PRIVATE_EVIDENCE'},sources:[{id:'help',title:'帮助',content:'PRIVATE_CONTENT'}],question:{title:'PRIVATE_QUESTION',options:[{label:'PRIVATE_OPTION'}]}}});
  assert.equal(t.intent,null);assert.equal(t.classification.confidence,null);assert.equal(t.classification.source,null);assert.equal(t.optionCount,1);assert.ok(!JSON.stringify(t).includes('PRIVATE'));
});
test('AI traces link real internal HTTP calls to atomic business effects without private payloads',{skip:process.env.TEST_OPERATIONS!=='1'},async t=>{
  const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','agent/schema.sql','operations/inbox-schema.sql','citywalk-expansion-schema.sql','operations/product-schema.sql']});
  const store=createAgentStore(f),conversation=await store.start(f.users.user.id),foreign=await store.start(f.users.other.id);
  installAgentInsights(f.app,f);let port,lastTurn;
  f.app.post('/api/citywalks',f.auth,async(req,res)=>{
    const id=randomUUID();await f.query("INSERT INTO citywalks(id,user_id,title,city,stops,distance_m) VALUES($1,$2,'PRIVATE_WALK','{}','[{},{}]',1500)",[id,req.user.id]);res.status(201).json({id});
  });
  f.app.get('/api/places',f.auth,(req,res)=>req.query.fail?res.status(503).json({error:'provider unavailable'}):res.json([]));
  f.app.post('/api/test/trace',f.auth,async(req,res)=>{
    const run=await store.begin(conversation.id,req.user.id,randomUUID(),'PRIVATE_INPUT',req.body.revision||0);
    lastTurn=run.token;
    const call=createApiBridge({port,userId:req.user.id,conversationId:conversation.id,session:req.cookies.st_session,query:f.query,turnId:run.token,parentRequestId:req.operationRequestId});
    let status='completed',reply;
    try{await call('GET','/api/places?q=PRIVATE_QUERY'+(req.body.fail?'&fail=1':''));const walk=await call('POST','/api/citywalks',{secret:'PRIVATE_BODY'});reply={text:'PRIVATE_OUTPUT',intent:'operate',classification:{source:'rule',confidence:0.98,capability:'create_citywalk'},steps:['正在识别需求…','正在保存已确认的内容…'],walkId:walk.id};}
    catch{status='failed';reply={text:'PRIVATE_ERROR',intent:'operate',error:true};}
    res.json(await store.finish(run.conversation,req.user.id,run.token,{},reply,status));
  });
  try{
    port=await f.start();let trace;
    await t.test('AI01 server request → turn → internal request → committed effect; audit stored',async()=>{
      const r=await f.request('/api/test/trace',{user:'user',body:{}});assert.equal(r.status,200);
      trace=(await f.request('/api/admin/agent/conversations/'+conversation.id)).data;
      assert.equal(trace.turns.length,1);assert.equal(trace.tools.length,2);assert.equal(trace.effects.length,1);assert.equal(trace.effects[0].event_type,'citywalk.saved');
      assert.equal(trace.turns[0].serverRequestId,r.headers.get('x-request-id'));assert.ok(trace.turns[0].durationMs>=0);assert.ok(trace.turns[0].finishedAt);
      for(const call of trace.tools){assert.equal(call.turn_id,lastTurn);assert.equal(call.parent_request_id,r.headers.get('x-request-id'));assert.match(call.request_id,/^[a-f\d-]{36}$/);assert.equal(call.outcome,'http_success');assert.ok(call.duration_ms>=0);assert.ok(!call.path.includes('?'));}
      assert.equal(trace.effects[0].request_id,trace.tools.find(x=>x.method==='POST').request_id);assert.equal(trace.tokenUsage,null);assert.equal(trace.cost,null);
      assert.ok(!JSON.stringify(trace).includes('PRIVATE'));assert.ok(!JSON.stringify(trace).includes('st_session'));
      assert.equal((await f.query("SELECT count(*)::int n FROM operation_events WHERE action='agent.trace_read' AND resource_id=$1",[conversation.id])).rows[0].n,1);
    });
    await t.test('AI02 HTTP failure and network failure are distinct; no implicit retry or fabricated success',async()=>{
      const r=await f.request('/api/test/trace',{user:'user',body:{revision:1,fail:true}});assert.equal(r.status,200);assert.equal(r.data.error,true);
      const calls=(await f.query('SELECT * FROM agent_tool_calls WHERE turn_id=$1',[lastTurn])).rows;assert.equal(calls.length,1);assert.equal(calls[0].outcome,'http_error');assert.equal(calls[0].status,503);
      const call=createApiBridge({port,userId:f.users.user.id,conversationId:conversation.id,session:'a'.repeat(64),query:f.query,turnId:lastTurn,fetchImpl:async()=>{throw Error('network');}});
      await assert.rejects(()=>call('GET','/api/places?q=PRIVATE_QUERY'),e=>e.status===503);
      const failed=(await f.query("SELECT status,outcome,duration_ms FROM agent_tool_calls WHERE outcome='network_error'")).rows[0];assert.equal(failed.status,null);assert.ok(failed.duration_ms>=0);
      assert.equal((await f.request('/api/admin/agent/conversations?state=issues')).data.items.length,1);
    });
    await t.test('AI03 legacy calls stay unlinked and cannot expose query strings or foreign effects',async()=>{
      await f.query("INSERT INTO agent_tool_calls(conversation_id,user_id,method,path,status) VALUES($1,$2,'GET','/api/places?q=PRIVATE_LEGACY',200)",[conversation.id,f.users.user.id]);
      await f.query("INSERT INTO product_events(user_id,event_type,resource_type,resource_id,request_id,source) VALUES($1,'trip.saved','trip','FOREIGN_EFFECT',$2,'database')",[f.users.other.id,trace.tools[0].request_id]);
      const v=(await f.request('/api/admin/agent/conversations/'+conversation.id)).data;
      assert.ok(v.tools.some(c=>c.turn_id===null&&c.duration_ms===null));assert.ok(!JSON.stringify(v).includes('PRIVATE'));assert.ok(!JSON.stringify(v).includes('FOREIGN_EFFECT'));
      assert.equal((await f.request('/api/admin/agent/conversations/'+foreign.id)).data.effects.length,0);
      assert.equal((await f.request('/api/admin/agent/conversations/'+randomUUID())).status,404);
      assert.equal((await f.request('/api/admin/agent/conversations/'+conversation.id+'?offset=-1')).status,400);
    });
    await t.test('AI04 permissions and pressure: 120 traces at concurrency 8',async()=>{
      const path='/api/admin/agent/conversations/'+conversation.id;
      assert.equal((await f.request(path,{user:null})).status,401);assert.equal((await f.request(path,{user:'user'})).status,403);
      for(const role of ['support','operator','analyst']){
        const current=(await f.query('SELECT version FROM admin_memberships WHERE user_id=$1',[f.users.other.id])).rows[0]?.version||0;
        await f.request('/api/admin/access/members/'+f.users.other.id,{method:'PUT',body:{role,version:current,confirmation:'change-role'}});
        const login=await f.request('/api/auth/admin/login',{user:null,body:{username:f.users.other.username,password:f.password}});
        const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');assert.equal((await f.request(path,{headers:{Cookie:cookie}})).status,403);
      }
      let index=0;const durations=[];
      await Promise.all(Array.from({length:8},async()=>{while(index<120){index++;const start=performance.now(),r=await f.request(path);assert.equal(r.status,200);assert.ok(!JSON.stringify(r.data).includes('PRIVATE'));durations.push(performance.now()-start);}}));
      durations.sort((a,b)=>a-b);console.log('PRESSURE AI traces: 120 requests/concurrency 8, p95='+Math.round(durations[Math.floor(durations.length*.95)])+'ms');
    });
  }finally{await f.close();}
});
