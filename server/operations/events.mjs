/* 记录用户操作和业务事件。 */

import { randomUUID } from 'node:crypto';

export function createEventRecorder({query, maximumQueue=2000, intervalMs=1000}) {
  let queue=[], pending=null, dropped=0, failed=0;
  async function append(event, client={query}) {
    await client.query(`INSERT INTO operation_events(user_id,kind,action,resource_id,request_id,status,duration_ms,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[event.userId||null,event.kind,event.action,event.resourceId||null,event.requestId||null,event.status||null,event.durationMs??null,JSON.stringify(event.metadata||{})]);
  }
  function record(event) {
    if(queue.length>=maximumQueue){dropped++;return;}
    queue.push(event);
  }
  async function flush() {
    if(pending) return pending;
    if(!queue.length)return;
    const batch=queue.splice(0,100);
    pending=(async()=>{
      try {
        await query(`INSERT INTO operation_events(user_id,kind,action,resource_id,request_id,status,duration_ms,metadata)
          SELECT x.user_id,x.kind,x.action,x.resource_id,x.request_id,x.status,x.duration_ms,x.metadata
          FROM jsonb_to_recordset($1::jsonb) AS x(user_id uuid,kind text,action text,resource_id text,request_id uuid,status integer,duration_ms integer,metadata jsonb)`,[JSON.stringify(batch.map(e=>({user_id:e.userId||null,kind:e.kind,action:e.action,resource_id:e.resourceId||null,request_id:e.requestId||null,status:e.status||null,duration_ms:e.durationMs??null,metadata:e.metadata||{}})))]);
      }catch{failed+=batch.length;}finally{pending=null;}
    })();
    return pending;
  }
  const timer=setInterval(()=>void flush(),intervalMs);timer.unref();
  function middleware(req,res,next) {
    req.operationRequestId=randomUUID();
    const started=performance.now();
    res.set('X-Request-Id',req.operationRequestId);
    res.once('finish',()=>{
      let route=typeof req.route?.path==='string'?req.route.path:null;
      if(route && /^\/(auth|me)(\/|$)/.test(route))route='/api'+route;
      if(!route || !route.startsWith('/api/') || route.includes('/progress') || route==='/api/activity')return;
      const actor=req.user?.id||req.auditUserId;
      if(!actor)return;
      record({userId:actor,kind:'request',action:req.method+' '+route,requestId:req.operationRequestId,
        status:res.statusCode,durationMs:Math.min(2147483647,Math.round(performance.now()-started))});
    });
    next();
  }
  function systemError(req,error) {
    if(error.name==='ZodError'||error.code==='23503')return;
    if(error.status && error.status<500)return;
    record({kind:'system',action:'request.failed',requestId:req.operationRequestId,
      metadata:{code:/^[A-Z0-9_]{1,40}$/.test(error.code||'')?error.code:'INTERNAL_ERROR'}});
  }
  return {append,record,flush,middleware,systemError,stats:()=>({queued:queue.length,dropped,failed}),
    async close(){clearInterval(timer);await pending;while(queue.length)await flush();}};
}
