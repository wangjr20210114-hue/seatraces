import {z} from 'zod';
import {gzip,createGzip} from 'node:zlib';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {eventQuery,logFilterSchema} from './event-query.mjs';
import {requireRawCoverage} from './archive-coverage.mjs';
const compress=promisify(gzip);
const fail=(message,status=400,code='EXPORT_INVALID')=>Object.assign(Error(message),{status,code});
export const exportLimits=Object.freeze({rows:100000,rawBytes:128*1024*1024,rowBytes:512*1024,batchRows:50,chunkBytes:2*1024*1024,hours:24,queued:5});
// Store only a bounded list of IDs. Large event payloads never enter this query's
// result. Late events cannot enter an already accepted export.
export async function captureLogSelection(query,input,maxRows=exportLimits.rows){
 const q=eventQuery(input);
 await requireRawCoverage(query,q.values[0],q.values[1],{stream:'operation',userId:q.values[2]});
 const r=(await query(`SELECT count(*)::int total,coalesce(array_agg(id ORDER BY n),'{}'::bigint[]) ids,
   coalesce(sum(bytes),0)::bigint bytes,coalesce(max(bytes),0)::int max_bytes FROM (
   SELECT e.id,octet_length(to_jsonb(e)::text)+1024 bytes,row_number() OVER(ORDER BY ${q.order}) n
   FROM operation_events e LEFT JOIN users u ON u.id=e.user_id WHERE ${q.where} ORDER BY ${q.order} LIMIT $${q.values.length+1}
 ) selected`,[...q.values,maxRows+1])).rows[0];
 if(r.total>maxRows)throw fail(`日志超过 ${maxRows.toLocaleString('en-US')} 条，请缩小日期范围`,413,'EXPORT_OVERSIZE');
 if(Number(r.bytes)>exportLimits.rawBytes||r.max_bytes>exportLimits.rowBytes)throw fail('日志体积超出导出预算，请缩小范围',413,'EXPORT_OVERSIZE');
 return {ids:r.ids,total:r.total,bytes:Number(r.bytes),filters:q.filters};
}
async function readRows(query,ids){
 const rows=(await query(`SELECT e.*,u.username FROM unnest($1::bigint[]) WITH ORDINALITY selected(id,n)
   JOIN operation_events e ON e.id=selected.id LEFT JOIN users u ON u.id=e.user_id ORDER BY selected.n`,[ids])).rows;
 if(rows.length!==ids.length)throw fail('所选日志已变化或被归档，请重新创建导出',409,'EXPORT_SOURCE_CHANGED');
 return rows;
}
async function* logBuffers(query,ids){
 let bytes=0;
 for(let i=0;i<ids.length;i+=exportLimits.batchRows){
  const rows=await readRows(query,ids.slice(i,i+exportLimits.batchRows));
  for(const row of rows){const data=Buffer.from(JSON.stringify(row)+'\n');bytes+=data.length;
   if(data.length>exportLimits.rowBytes||bytes>exportLimits.rawBytes)throw fail('日志体积变化，请重新导出',413,'EXPORT_OVERSIZE');yield data;}
 }
}
function headers(res,name='seatraces-operations.log.gz'){res.set({'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});}
export async function streamLegacyLogs(req,res,{query,events}){
 const s=await captureLogSelection(query,req.query,20000);
 await events.append({userId:req.user.id,kind:'admin',action:'logs.export',requestId:req.operationRequestId,metadata:{rows:s.total,delivery:'stream'}});
 headers(res);
 try{await pipeline(Readable.from(logBuffers(query,s.ids)),createGzip(),res);}catch(e){if(res.headersSent||res.destroyed){res.destroy();events.systemError?.(req,e);}else throw e;}
}
export function createLogExportService({query,transaction,events}){
 const audit=(req,action,id,metadata={},c)=>events.append({userId:req.user.id,kind:'admin',action,resourceId:id,requestId:req.operationRequestId,metadata},c);
 const cleanup=()=>query(`DELETE FROM admin_log_exports e USING maintenance_tasks t WHERE e.id=t.id AND e.expires_at<=now() AND t.state NOT IN ('queued','running')`);
 async function authorizeOwner(c,id){
  // Export privilege currently belongs only to administrators. Recheck for work
  // accepted before an account was disabled or demoted.
  const u=(await c.query('SELECT role,disabled_at,username FROM users WHERE id=$1 FOR SHARE',[id])).rows[0];
  if(!u||u.role!=='admin'||u.disabled_at||/^demo_[a-f0-9]{8}$/.test(u.username))throw fail('导出权限已失效',403,'EXPORT_ACCESS_REVOKED');
 }
 async function execute({task,checkpoint,workerId}){
  await checkpoint({step:'exporting',completedRows:0});
  const e=(await query('SELECT * FROM admin_log_exports WHERE id=$1',[task.id])).rows[0];
  if(!e||new Date(e.expires_at)<=new Date())throw fail('导出已过期',410,'EXPORT_EXPIRED');
  let done=0,sequence=0,rawBytes=0,compressedBytes=0;
  await query('DELETE FROM admin_log_export_chunks WHERE export_id=$1',[e.id]);
  async function store(buffers,rows){
   const raw=Buffer.concat(buffers),payload=await compress(raw);
   await transaction(async c=>{
    await authorizeOwner(c,e.owner_id);
    const live=(await c.query("SELECT cancel_requested FROM maintenance_tasks WHERE id=$1 AND worker_id=$2 AND state='running' AND lease_until>now() FOR UPDATE",[task.id,workerId])).rows[0];
    if(!live)throw fail('任务已取消或执行权限失效',409,'LEASE_LOST');
    if(live.cancel_requested)throw fail('任务已取消',409,'TASK_CANCELLED');
    await c.query('INSERT INTO admin_log_export_chunks(export_id,sequence,row_count,raw_bytes,payload) VALUES($1,$2,$3,$4,$5)',[e.id,sequence++,rows,raw.length,payload]);
   });
   done+=rows;rawBytes+=raw.length;compressedBytes+=payload.length;
   if(rawBytes>exportLimits.rawBytes)throw fail('导出超出体积预算',413,'EXPORT_OVERSIZE');
   await checkpoint({step:'exporting',completedRows:done,totalRows:e.total_rows,percent:e.total_rows?Math.floor(done/e.total_rows*100):100});
  }
  try{
   let buffers=[],count=0,bytes=0;
   for await(const data of logBuffers(query,e.selected_ids)){
    if(count&&(count>=exportLimits.batchRows||bytes+data.length>exportLimits.chunkBytes)){await store(buffers,count);buffers=[];count=0;bytes=0;}
    buffers.push(data);count++;bytes+=data.length;
   }
   if(count||!e.total_rows)await store(buffers,count);
   await events.append({userId:e.owner_id,kind:'admin',action:'logs.export_prepared',resourceId:e.id,metadata:{rows:done,chunks:sequence,rawBytes,compressedBytes}});
   return {rows:done,chunks:sequence,rawBytes,compressedBytes,expiresAt:e.expires_at};
  }catch(error){await query('DELETE FROM admin_log_export_chunks WHERE export_id=$1',[e.id]);throw error;}
 }
 function install(app){
  app.post('/api/admin/events/exports',async(req,res)=>{
   const b=z.object({id:z.uuid(),filters:logFilterSchema.strict()}).strict().parse(req.body);
   const result=await transaction(async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('seatraces.log-export-create',0))");
    await authorizeOwner(c,req.user.id);
    const old=(await c.query('SELECT e.id,e.owner_id,e.filters=$2::jsonb same,e.total_rows FROM admin_log_exports e WHERE id=$1',[b.id,b.filters])).rows[0];
    if(old){if(old.owner_id!==req.user.id||!old.same)throw fail('导出编号已使用',409);return {id:old.id,totalRows:old.total_rows};}
    if((await c.query('SELECT 1 FROM maintenance_tasks WHERE id=$1',[b.id])).rowCount)throw fail('任务编号已使用',409);
    const active=(await c.query("SELECT requested_by FROM maintenance_tasks WHERE kind='log_export' AND state IN ('queued','running')")).rows;
    if(active.some(x=>x.requested_by===req.user.id))throw fail('已有导出任务等待或运行中，请等待完成',409);
    if(active.length>=exportLimits.queued)throw fail('导出队列已满，请稍后重试',429);
    const selection=await captureLogSelection(c.query.bind(c),b.filters);
    await c.query("INSERT INTO maintenance_tasks(id,kind,requested_by,parameters) VALUES($1,'log_export',$2,$3)",[b.id,req.user.id,{exportId:b.id}]);
    await c.query('INSERT INTO admin_log_exports(id,owner_id,filters,selected_ids,total_rows,estimated_bytes) VALUES($1,$2,$3,$4,$5,$6)',[b.id,req.user.id,b.filters,selection.ids,selection.total,selection.bytes]);
    await audit(req,'logs.export_queued',b.id,{rows:selection.total},c);return {id:b.id,totalRows:selection.total};
   });res.status(202).json(result);
  });
  app.get('/api/admin/events/exports',async(req,res)=>{
   await cleanup();const rows=(await query(`SELECT e.id,e.total_rows,e.expires_at,e.created_at,t.state,t.progress,t.result,t.error_code FROM admin_log_exports e JOIN maintenance_tasks t ON t.id=e.id
    WHERE e.owner_id=$1 AND e.expires_at>now() ORDER BY e.created_at DESC,e.id LIMIT 20`,[req.user.id])).rows;
   res.json({items:rows,limits:exportLimits});
  });
  app.get('/api/admin/events/exports/:id',async(req,res)=>{
   const row=(await query(`SELECT e.id,e.total_rows,e.expires_at,e.created_at,t.state,t.progress,t.result,t.error_code FROM admin_log_exports e JOIN maintenance_tasks t ON t.id=e.id WHERE e.id=$1 AND e.owner_id=$2 AND e.expires_at>now()`,[z.uuid().parse(req.params.id),req.user.id])).rows[0];
   if(!row)throw fail('导出不存在或已过期',404);res.json(row);
  });
  app.get('/api/admin/events/exports/:id/file',async(req,res)=>{
   const id=z.uuid().parse(req.params.id);
   const row=(await query(`SELECT e.id,e.total_rows,t.state,t.result FROM admin_log_exports e JOIN maintenance_tasks t ON t.id=e.id WHERE e.id=$1 AND e.owner_id=$2 AND e.expires_at>now()`,[id,req.user.id])).rows[0];
   if(!row)throw fail('导出不存在或已过期',404);if(row.state!=='completed')throw fail('导出尚未完成',409);
   const counts=(await query('SELECT count(*)::int chunks,coalesce(sum(row_count),0)::int rows FROM admin_log_export_chunks WHERE export_id=$1',[id])).rows[0];
   if(counts.rows!==row.total_rows||counts.chunks!==row.result.chunks)throw fail('导出文件不完整，请重新创建',409);
   await audit(req,'logs.export_download',id,{rows:row.total_rows});
   async function* chunks(){for(let i=0;i<counts.chunks;i++){const r=(await query('SELECT payload FROM admin_log_export_chunks WHERE export_id=$1 AND sequence=$2',[id,i])).rows[0];if(!r)throw fail('导出已过期',410);yield r.payload;}}
   headers(res,`seatraces-operations-${id}.log.gz`);
   try{await pipeline(Readable.from(chunks()),res);}catch(e){if(res.headersSent||res.destroyed){res.destroy();events.systemError?.(req,e);}else throw e;}
  });
 }
 return {install,execute,cleanup};
}
