/* 记录请求与数据库调用链，提供追踪查询。 */

import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {requireManagement} from './permissions.mjs';
const active=new AsyncLocalStorage(),id=n=>randomBytes(n).toString('hex');
const sampledMemory=()=>({rss:process.memoryUsage.rss(),heap:process.memoryUsage().heapUsed});
const attributes=v=>Object.fromEntries(Object.entries(v||{}).filter(([k,val])=>['provider','sqlOperation','method'].includes(k)&&typeof val==='string'&&/^[A-Za-z_]{1,32}$/.test(val)));
export async function traceSpan(kind,name,fn,attrs={}){
 const ctx=active.getStore();if(!ctx||ctx.trace.closed)return fn();
 const t=ctx.trace;if(t.startedSpans>=63){t.droppedSpans++;return fn();}t.startedSpans++;
 const span={id:id(8),parentId:ctx.spanId,kind:['db','map','model','http'].includes(kind)?kind:'http',name:/^[a-z.]{1,40}$/.test(name)?name:'operation',attributes:attributes(attrs)},start=performance.now();
 t.maxSampledRss=Math.max(t.maxSampledRss,process.memoryUsage.rss());
 try{return await active.run({trace:t,spanId:span.id},fn);}catch(error){span.error=true;span.errorStatus=Number.isInteger(error.status)?error.status:500;throw error;}
 finally{span.startOffsetMs=Math.max(0,Math.round(start-t.clock));span.durationMs=Number((performance.now()-start).toFixed(2));t.maxSampledRss=Math.max(t.maxSampledRss,process.memoryUsage.rss());if(!t.closed)t.spans.push(span);}
}
export function createRequestTracer({write,maximumQueue=128,intervalMs=2000}={}){
 let queue=[],pending=null,timer,dropped=0,failed=0;
 function middleware(req,res,next){
  const clock=performance.now(),memory=sampledMemory(),root=id(8),trace={traceId:id(16),rootId:root,clock,startedAt:new Date().toISOString(),spans:[],startedSpans:0,droppedSpans:0,maxSampledRss:memory.rss,closed:false};
  res.set('X-Trace-Id',trace.traceId);let finished=false;
  const finish=()=>{
   if(finished)return;finished=true;trace.closed=true;
   const end=sampledMemory(),duration=Number((performance.now()-clock).toFixed(2)),route=typeof req.route?.path==='string'?req.route.path:'unresolved';
   const record={requestId:req.operationRequestId||randomUUID(),traceId:trace.traceId,method:['GET','POST','PATCH','PUT','DELETE','HEAD','OPTIONS'].includes(req.method)?req.method:'OTHER',route:route.slice(0,160),status:res.writableFinished?res.statusCode:499,durationMs:duration,startedAt:trace.startedAt,
    payload:{rootId:root,spans:trace.spans,droppedSpans:trace.droppedSpans,incompleteSpans:trace.startedSpans-trace.spans.length,
     memory:{rssStart:memory.rss,rssEnd:end.rss,maxSampledRss:Math.max(trace.maxSampledRss,end.rss),heapStart:memory.heap,heapEnd:end.heap,scope:'process_sampled_at_span_boundaries_not_per_request_allocation'}}};
   if(queue.length>=maximumQueue)dropped++;else queue.push(record);
  };res.once('finish',finish);res.once('close',finish);active.run({trace,spanId:root},next);
 }
 async function flush(){if(pending)return pending;if(!queue.length)return;
  const batch=queue.splice(0,16);pending=(async()=>{try{await write(batch);}catch{failed+=batch.length;}finally{pending=null;}})();return pending;
 }
 return {middleware,flush,stats:()=>({queued:queue.length,dropped,failed,maximumQueue,maxSpans:64}),
  start(){if(!timer){timer=setInterval(()=>void flush(),intervalMs);timer.unref();}},async close(){clearInterval(timer);timer=null;while(queue.length)await flush();await pending;}};
}
export function createDatabaseTraceSink(rawQuery){return async batch=>{
 await rawQuery(`INSERT INTO request_traces(request_id,trace_id,method,route,status,duration_ms,started_at,payload)
  SELECT x.request_id,x.trace_id,x.method,x.route,x.status,x.duration_ms,x.started_at,x.payload FROM jsonb_to_recordset($1::jsonb)
  AS x(request_id uuid,trace_id char(32),method varchar(8),route varchar(160),status integer,duration_ms double precision,started_at timestamptz,payload jsonb)
  ON CONFLICT(request_id) DO NOTHING`,[JSON.stringify(batch.map(x=>({request_id:x.requestId,trace_id:x.traceId,method:x.method,route:x.route,status:x.status,duration_ms:x.durationMs,started_at:x.startedAt,payload:x.payload})))]);
 await rawQuery("DELETE FROM request_traces WHERE request_id IN (SELECT request_id FROM request_traces WHERE started_at<now()-interval '7 days' ORDER BY started_at LIMIT 500)");
};}
export function installTraceRoutes(app,{query,tracer}){
 app.get('/api/admin/traces',requireManagement,async(req,res)=>{
  const b=z.object({requestId:z.uuid().optional(),offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict().parse(req.query);
  const items=(await query('SELECT request_id,trace_id,method,route,status,duration_ms,started_at FROM request_traces WHERE ($1::uuid IS NULL OR request_id=$1) ORDER BY started_at DESC,request_id LIMIT 31 OFFSET $2',[b.requestId||null,b.offset])).rows;
  res.json({items:items.slice(0,30),hasMore:items.length>30,health:tracer.stats(),retentionDays:7});
 });
 app.get('/api/admin/traces/:id',requireManagement,async(req,res)=>{const r=(await query('SELECT * FROM request_traces WHERE request_id=$1',[z.uuid().parse(req.params.id)])).rows[0];if(!r)return res.status(404).json({error:'链路不存在或已过保留期'});res.json(r);});
}
