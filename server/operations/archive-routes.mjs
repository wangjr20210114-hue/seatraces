import {z} from 'zod';
import {requireManagement} from './permissions.mjs';
import {archiveWindow,archiveTables,archiveMaxBytes,decodeArchive} from './event-archive.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(30),offset:z.coerce.number().int().min(0).max(10000).default(0)});
export function installArchiveRoutes(app,{query,transaction,events}){
  const audit=(req,action,id,metadata={},c)=>events.append({userId:req.user.id,kind:'admin',action,resourceId:id,requestId:req.operationRequestId,metadata},c);
  async function policy(c={query}){
    const p=(await c.query(`SELECT raw_retention_days,aggregate_retention_months,
      ((now()-raw_retention_days*interval '1 day') AT TIME ZONE 'Asia/Shanghai')::date::text cutoff_day
      FROM analytics_settings WHERE id=1`)).rows[0];
    return {...p,adminAuditRetentionDays:365,maxRows:20000,maxDays:31,maxChunkBytes:archiveMaxBytes,automaticArchiving:false,archiveDeletionEnabled:false};
  }
  async function queue(c,req,{id,kind,parameters},action){
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('seatraces.maintenance-create',0))");
    const old=(await c.query('SELECT id,kind,requested_by,parameters FROM maintenance_tasks WHERE id=$1',[id])).rows[0];
    if(old){if(old.kind!==kind||old.requested_by!==req.user.id||JSON.stringify(old.parameters)!==JSON.stringify(parameters)){
      // jsonb orders object keys, so use a database comparison for replay equivalence.
      const same=(await c.query('SELECT kind=$2 AND requested_by=$3 AND parameters=$4::jsonb same FROM maintenance_tasks WHERE id=$1',[id,kind,req.user.id,parameters])).rows[0];
      if(!same?.same)throw fail('任务编号已使用',409);
    }return {id:old.id};}
    if((await c.query("SELECT 1 FROM maintenance_tasks WHERE kind=$1 AND state IN ('queued','running')",[kind])).rowCount)throw fail('已有同类维护任务等待或正在运行',409);
    await c.query('INSERT INTO maintenance_tasks(id,kind,requested_by,parameters) VALUES($1,$2,$3,$4)',[id,kind,req.user.id,parameters]);
    await audit(req,action,id,{kind},c);return {id};
  }
  app.get('/api/admin/archives/policy',requireManagement,async(req,res)=>res.json(await policy()));
  app.post('/api/admin/archives/preview',requireManagement,async(req,res)=>{
    const b=z.object({id:z.uuid(),stream:z.enum(['operation','product']),from:z.iso.date(),to:z.iso.date()}).strict().parse(req.body),range=archiveWindow(b);
    const result=await transaction(async c=>{
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[b.id]);
      const old=(await c.query('SELECT *,from_day::text from_text,to_day::text to_text FROM event_archive_previews WHERE id=$1',[b.id])).rows[0];
      if(old){if(old.requested_by!==req.user.id||old.stream!==b.stream||old.from_text!==b.from||old.to_text!==b.to)throw fail('预览编号已使用',409);
        return {id:old.id,stream:old.stream,rows:old.selected_count,bytes:Number(old.source_bytes),expiresAt:old.expires_at};}
      const p=await policy(c);if(b.to>=p.cutoff_day)throw fail('归档范围必须早于 '+p.cutoff_day);
      const table=archiveTables[b.stream];
      const records=(await c.query(`SELECT id::text,octet_length(to_jsonb(e)::text)::int bytes FROM ${table} e
        WHERE created_at >=$1 AND created_at<$2 ${b.stream==='operation'?"AND (kind<>'admin' OR created_at<now()-interval '365 days')":''}
        ORDER BY created_at,id LIMIT 20001`,[range.start,range.end])).rows;
      if(records.length>p.maxRows)throw fail('超过20,000条，请缩小日期范围后预览',413);
      if(records.some(r=>r.bytes+100>archiveMaxBytes))throw fail('包含超过归档预算的单条记录，请先检查日志资料',413);
      const ids=records.map(r=>r.id),bytes=records.reduce((n,r)=>n+r.bytes,0);
      const r=(await c.query(`INSERT INTO event_archive_previews(id,requested_by,stream,from_day,to_day,selected_ids,selected_count,source_bytes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING expires_at`,[b.id,req.user.id,b.stream,b.from,b.to,JSON.stringify(ids),ids.length,bytes])).rows[0];
      await audit(req,'archive.preview',b.id,{stream:b.stream,from:b.from,to:b.to,rows:ids.length},c);
      await c.query('DELETE FROM event_archive_previews WHERE expires_at<now() AND task_id IS NULL');
      return {id:b.id,stream:b.stream,rows:ids.length,bytes,expiresAt:r.expires_at};
    });res.json(result);
  });
  app.post('/api/admin/archives/start',requireManagement,async(req,res)=>{
    const b=z.object({id:z.uuid(),previewId:z.uuid(),confirmation:z.literal('archive-events')}).strict().parse(req.body);
    const result=await transaction(async c=>{
      const p=(await c.query('SELECT *,from_day::text from_text,to_day::text to_text FROM event_archive_previews WHERE id=$1 AND requested_by=$2 FOR UPDATE',[b.previewId,req.user.id])).rows[0];
      if(!p)throw fail('预览不存在',404);if(p.task_id)return {id:p.task_id};
      if(new Date(p.expires_at)<=new Date())throw fail('预览已过期，请重新预览',409);
      if(!p.selected_count)throw fail('没有可归档记录');
      const pol=await policy(c);if(p.to_text>=pol.cutoff_day)throw fail('保留策略已变化，请重新预览',409);
      const r=await queue(c,req,{id:b.id,kind:'event_archive',parameters:{previewId:p.id}},'archive.queued');
      await c.query('UPDATE event_archive_previews SET task_id=$2 WHERE id=$1',[p.id,r.id]);return r;
    });res.status(202).json(result);
  });
  app.get('/api/admin/archives',requireManagement,async(req,res)=>{
    const {limit,offset}=paging.parse(req.query),stream=z.enum(['all','operation','product']).default('all').parse(req.query.stream);
    const rows=(await query(`SELECT id,stream,row_count,first_at,last_at,raw_bytes,octet_length(payload) compressed_bytes,
      sha256,created_at,restored_at,version FROM event_archives WHERE $1='all' OR stream=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`,[stream,limit+1,offset])).rows;
    res.json({items:rows.slice(0,limit),hasMore:rows.length>limit});
  });
  app.get('/api/admin/archives/:id/download',requireManagement,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),r=(await query('SELECT * FROM event_archives WHERE id=$1',[id])).rows[0];if(!r)throw fail('归档不存在',404);
    await decodeArchive(r);await audit(req,'archive.download',id,{stream:r.stream,rows:r.row_count});
    res.set({'Content-Type':'application/gzip','Content-Disposition':'attachment; filename="seatraces-events-'+id+'.json.gz"','Cache-Control':'no-store'}).send(r.payload);
  });
  app.post('/api/admin/archives/:id/restore',requireManagement,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),b=z.object({id:z.uuid(),version:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/),confirmation:z.literal('restore-events')}).strict().parse(req.body);
    const result=await transaction(async c=>{
      const a=(await c.query('SELECT id,version,sha256,restored_at,restore_task_id FROM event_archives WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!a)throw fail('归档不存在',404);if(a.restored_at)return {id:a.restore_task_id};
      if(a.version!==b.version||a.sha256!==b.sha256)throw fail('归档状态已变化，请刷新',409);
      return queue(c,req,{id:b.id,kind:'archive_restore',parameters:{archiveId:id}},'archive.restore_queued');
    });res.status(202).json(result);
  });
  app.post('/api/admin/archives/rollups',requireManagement,async(req,res)=>{
    const b=z.object({id:z.uuid(),from:z.iso.date(),to:z.iso.date(),confirmation:z.literal('summarize-events')}).strict().parse(req.body);archiveWindow(b);
    const r=await transaction(c=>queue(c,req,{id:b.id,kind:'daily_rollup',parameters:{from:b.from,to:b.to}},'rollup.queued'));res.status(202).json(r);
  });
  app.get('/api/admin/analytics/daily-archives',requireManagement,async(req,res)=>{
    const range=archiveWindow(req.query,{maximumDays:366});
    const rows=(await query('SELECT day::text,metrics,coverage,frozen,computed_at FROM analytics_daily_rollups WHERE day>=$1 AND day<=$2 ORDER BY day DESC',[range.from,range.to])).rows;
    res.json({items:rows,window:{from:range.from,to:range.to,timezone:'Asia/Shanghai'},scope:'计算时的正式用户范围；每日活跃为独立人数，不能跨日相加作为去重人数',missingDays:'尚未汇总或已超过汇总保留期，不等于零'});
  });
}
