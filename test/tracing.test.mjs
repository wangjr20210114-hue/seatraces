/* 验证请求和数据库调用追踪。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {createRequestTracer,createDatabaseTraceSink,traceSpan,installTraceRoutes} from '../server/operations/tracing.mjs';
import {createJsonRequester} from '../server/integrations/http.mjs';
test('correlated traces preserve parallel ancestry, redact secrets and stay bounded on overload',
 {skip:process.env.TEST_TRACING!=='1',timeout:60000},async t=>{
 const f=await iterationFixture({schemas:['operations/tracing-schema.sql']});let tracer;
 try{
  tracer=createRequestTracer({write:createDatabaseTraceSink(f.query),maximumQueue:16});
  f.app.use('/api',tracer.middleware);installTraceRoutes(f.app,{query:f.query,tracer});
  const request=createJsonRequester({reserve:async()=>{},fetchImpl:async()=>({ok:true,json:async()=>({ok:true})})});
  f.app.post('/api/trace-fixture/:id',f.auth,async(req,res)=>{
   await traceSpan('db','db.query',()=>f.query('SELECT 1'),{sqlOperation:'SELECT',rawPassword:'never-log-this'});
   await traceSpan('http','catalog.request',()=>traceSpan('db','db.query',()=>f.query('SELECT 2'),{sqlOperation:'SELECT'}));
   await request('DeepSeek','https://example.invalid/?key=never-log-this',{body:'private-dialogue'});
   if(req.body.flood)for(let i=0;i<100;i++)await traceSpan('db','db.query',async()=>{});
   if(req.body.fail)throw Object.assign(Error('private-error-never-log-this'),{status:502});
   res.json({ok:true});
  });await f.start();
  const rs=await Promise.all(Array.from({length:12},(_,i)=>f.request('/api/trace-fixture/private-'+i+'?secret=never-log-this',{user:'user',body:{secret:'private-dialogue',fail:i===0,flood:i===1}})));
  assert.equal(rs[0].status,502);await tracer.flush();
  const rows=(await f.query('SELECT * FROM request_traces')).rows;assert.equal(rows.length,12);assert.equal(new Set(rows.map(x=>x.trace_id)).size,12);
  const serialized=JSON.stringify(rows);for(const secret of ['never-log-this','private-dialogue','private-error','private-0'])assert.ok(!serialized.includes(secret));
  for(const row of rows){assert.equal(row.route,'/api/trace-fixture/:id');assert.equal(row.payload.spans.filter(s=>s.kind==='model').length,1);assert.ok(row.payload.spans.length<=63);
   const parents=new Set([row.payload.rootId,...row.payload.spans.map(s=>s.id)]);assert.ok(row.payload.spans.every(s=>parents.has(s.parentId)));}
  assert.ok(rows.some(r=>r.payload.droppedSpans>0));
  assert.equal((await f.request('/api/admin/traces',{user:'user'})).status,403);
  const read=await f.request('/api/admin/traces');assert.equal(read.status,200);assert.equal(read.data.items.length,12);
  const detail=await f.request('/api/admin/traces/'+rows[0].request_id);assert.equal(detail.status,200);assert.ok(detail.data.payload.memory.maxSampledRss>0);await tracer.flush();
  const before=process.memoryUsage().rss,times=[],start=performance.now();
  for(let i=0;i<5;i++)await Promise.all(Array.from({length:20},async()=>{const s=performance.now();const r=await f.request('/api/trace-fixture/stress',{user:'user',body:{flood:true}});assert.equal(r.status,200);times.push(performance.now()-s);}));
  assert.ok(tracer.stats().queued<=16);assert.ok(tracer.stats().dropped>0);await tracer.flush();
  times.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({requests:100,concurrency:20,p95Ms:Math.round(times[Math.floor(times.length*.95)]),elapsedMs:Math.round(performance.now()-start),rssBeforeMiB:Math.round(before/1048576),rssAfterMiB:Math.round(process.memoryUsage().rss/1048576),tracer:tracer.stats(),scope:'isolated fixture, simulated provider; memory is whole process'}));
 }finally{await tracer?.close();await f.close();}
});
