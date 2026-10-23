/* 压缩归档历史日志，生成每日统计并读取归档内容。 */

import {randomUUID,createHash} from 'node:crypto';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {z} from 'zod';
const compress=promisify(gzip),decompress=promisify(gunzip);
export const archiveTables=Object.freeze({operation:'operation_events',product:'product_events'});
const idTypes=Object.freeze({operation:'bigint',product:'uuid'});
export const archiveMaxBytes=2*1024*1024;
const fail=(message,code='ARCHIVE_INVALID')=>Object.assign(Error(message),{code,status:409});
const dayMs=86400000;
const day=s=>new Date(new Date(s).getTime()+8*3600000).toISOString().slice(0,10);
export function archiveWindow(input,{maximumDays=31,today=new Date(),pastOnly=true}={}){
  const r=z.object({from:z.iso.date(),to:z.iso.date()}).parse(input);
  const start=new Date(r.from+'T00:00:00+08:00'),end=new Date(r.to+'T00:00:00+08:00');end.setTime(end.getTime()+dayMs);
  if(end<=start||(end-start)/dayMs>maximumDays||(pastOnly&&r.to>=day(today)))throw Object.assign(Error('请选择过去不超过 '+maximumDays+' 天的有效范围'),{status:400});
  return {...r,start:start.toISOString(),end:end.toISOString()};
}
export async function lockTask(c,task,workerId){
  const row=(await c.query(`SELECT state,worker_id,cancel_requested,lease_until>clock_timestamp() live
    FROM maintenance_tasks WHERE id=$1 FOR UPDATE`,[task.id])).rows[0];
  if(!row||row.state!=='running'||row.worker_id!==workerId||!row.live)throw fail('Task lease lost','LEASE_LOST');
  if(row.cancel_requested)throw fail('Task cancelled','TASK_CANCELLED');
}
export async function decodeArchive(row){
  if(row.raw_bytes>archiveMaxBytes||row.payload.length>2100000)throw fail('Archive size exceeds limit','ARCHIVE_OVERSIZE');
  let raw;try{raw=await decompress(row.payload,{maxOutputLength:archiveMaxBytes});}catch{throw fail('Archive checksum failed');}
  if(raw.length!==row.raw_bytes||createHash('sha256').update(raw).digest('hex')!==row.sha256)throw fail('Archive checksum failed');
  let value;try{value=JSON.parse(raw);}catch{throw fail('Invalid archive');}
  if(value.version!==1||value.stream!==row.stream||!Array.isArray(value.records)||value.records.length!==row.row_count)throw fail('Invalid archive envelope');
  return value;
}

export async function rollupDays(c,{from,to},freeze=false){
  const settings=(await c.query('SELECT started_at,aggregate_retention_months FROM analytics_settings WHERE id=1')).rows[0];
  let count=0;
  for(let d=new Date(from+'T00:00:00+08:00');day(d)<=to;d.setTime(d.getTime()+dayMs)){
    const date=day(d),start=d.toISOString(),end=new Date(d.getTime()+dayMs).toISOString();
    const old=(await c.query('SELECT frozen FROM analytics_daily_rollups WHERE day=$1',[date])).rows[0];
    if(old?.frozen)continue;
    if((await c.query('SELECT 1 FROM event_archives WHERE restored_at IS NULL AND first_at<$2 AND last_at>=$1 LIMIT 1',[start,end])).rowCount)continue;
    const metrics=(await c.query(`WITH eligible AS (SELECT id,created_at FROM users u WHERE role='user' AND NOT analytics_excluded AND created_at<$2
      AND NOT EXISTS(SELECT 1 FROM admin_memberships m WHERE m.user_id=u.id AND m.enabled)), activity AS (
      SELECT user_id FROM product_events WHERE created_at >=$1 AND created_at<$2 UNION
      SELECT user_id FROM operation_events WHERE kind='navigation' AND created_at >=$1 AND created_at<$2)
      SELECT (SELECT count(*)::int FROM activity a JOIN eligible u ON u.id=a.user_id) active,
      (SELECT count(*)::int FROM eligible WHERE created_at >=$1 AND created_at<$2) registered,
      (SELECT count(*)::int FROM trips t JOIN eligible u ON u.id=t.user_id WHERE t.created_at >=$1 AND t.created_at<$2) trips,
      (SELECT count(*)::int FROM citywalks t JOIN eligible u ON u.id=t.user_id WHERE t.created_at >=$1 AND t.created_at<$2) citywalks,
      (SELECT count(*)::int FROM operation_events WHERE created_at >=$1 AND created_at<$2) operations,
      (SELECT count(*)::int FROM operation_events WHERE kind='request' AND status>=500 AND created_at >=$1 AND created_at<$2) errors,
      (SELECT count(*)::int FROM product_events p JOIN eligible u ON u.id=p.user_id WHERE p.created_at >=$1 AND p.created_at<$2) business_events`,[start,end])).rows[0];
    const coverage={startedAt:settings.started_at,partial:new Date(start)<new Date(settings.started_at),scope:'eligible users at computation time',activeDefinition:'one navigation or business event',dailyDistinctOnly:true};
    await c.query(`INSERT INTO analytics_daily_rollups(day,metrics,coverage,frozen) VALUES($1,$2,$3,$4)
      ON CONFLICT(day) DO UPDATE SET metrics=excluded.metrics,coverage=excluded.coverage,frozen=excluded.frozen,computed_at=now()
      WHERE NOT analytics_daily_rollups.frozen`,[date,metrics,coverage,freeze]);count++;
  }
  await c.query("DELETE FROM analytics_daily_rollups WHERE day<(now() AT TIME ZONE 'Asia/Shanghai')::date-($1::int*interval '1 month')",[settings.aggregate_retention_months]);
  return count;
}

export function archiveExecutors({query,transaction,events}){
  const audit=(task,action,id,metadata,c)=>events.append({userId:task.requested_by,kind:task.requested_by?'admin':'system',action,resourceId:id,metadata},c);
  async function eventArchive({task,checkpoint,workerId}){
    const preview=(await query('SELECT * FROM event_archive_previews WHERE id=$1',[task.parameters.previewId])).rows[0];
    if(!preview?.task_id)throw fail('Archive preview not confirmed');
    const table=archiveTables[preview.stream];if(!table)throw fail('Unsupported archive stream');
    let total=preview.processed_count;
    while(total<preview.selected_count){
      await checkpoint({step:'archiving',processed:total,total:preview.selected_count});
      total=await transaction(async c=>{
        await lockTask(c,task,workerId);
        const p=(await c.query('SELECT * FROM event_archive_previews WHERE id=$1 FOR UPDATE',[preview.id])).rows[0];
        const ids=p.selected_ids.slice(p.processed_count,p.processed_count+500);
        const sizes=(await c.query(`SELECT id::text id,octet_length(to_jsonb(e)::text)::int bytes FROM ${table} e WHERE id=ANY($1::${idTypes[p.stream]}[]) ORDER BY array_position($1::text[],id::text) FOR UPDATE`,[ids])).rows;
        if(sizes.length!==ids.length)throw fail('Preview records changed','ARCHIVE_SOURCE_CHANGED');
        const selected=[];let bytes=100;
        for(const row of sizes){if(bytes+row.bytes+1>archiveMaxBytes)break;selected.push(row.id);bytes+=row.bytes+1;}
        if(!selected.length)throw fail('Single event exceeds limit','ARCHIVE_OVERSIZE');
        const rows=(await c.query(`SELECT (to_jsonb(e)||jsonb_build_object('id',e.id::text))::text raw,created_at::text at FROM ${table} e WHERE id=ANY($1::${idTypes[p.stream]}[]) ORDER BY created_at,id`,[selected])).rows;
        const first=rows[0].at,last=rows.at(-1).at;
        await rollupDays(c,{from:day(first),to:day(last)},true);
        const raw=Buffer.from('{"version":1,"stream":'+JSON.stringify(preview.stream)+',"records":['+rows.map(r=>r.raw).join(',')+']}');
        if(raw.length>archiveMaxBytes)throw fail('Archive exceeds limit','ARCHIVE_OVERSIZE');
        const payload=await compress(raw),sha256=createHash('sha256').update(raw).digest('hex'),id=randomUUID();
        const archive={raw_bytes:raw.length,payload,sha256,row_count:rows.length,stream:preview.stream};
        const decoded=await decodeArchive(archive),userIndex={},requestIds=new Set();
        for(const r of decoded.records){
          if(r.request_id)requestIds.add(r.request_id);
          if(!r.user_id)continue;
          const u=userIndex[r.user_id]??={count:0,lastAt:null,lastActivityAt:null};u.count++;
          if(!u.lastAt||new Date(r.created_at)>new Date(u.lastAt))u.lastAt=r.created_at;
          if(['request','navigation'].includes(r.kind)&&(!u.lastActivityAt||new Date(r.created_at)>new Date(u.lastActivityAt)))u.lastActivityAt=r.created_at;
        }
        await c.query(`INSERT INTO event_archives(id,preview_id,stream,row_count,first_at,last_at,raw_bytes,sha256,payload,user_index,event_ids,request_ids)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,p.id,p.stream,rows.length,first,last,raw.length,sha256,payload,userIndex,selected,[...requestIds]]);
        const removed=await c.query(`DELETE FROM ${table} WHERE id=ANY($1::${idTypes[p.stream]}[])`,[selected]);
        if(removed.rowCount!==rows.length)throw fail('Archive row count mismatch');
        const processed=p.processed_count+rows.length;
        await c.query('UPDATE event_archive_previews SET processed_count=$2 WHERE id=$1',[p.id,processed]);
        await audit(task,'events.archived',id,{stream:p.stream,rows:rows.length,rawBytes:raw.length},c);
        await lockTask(c,task,workerId);
        return processed;
      });
    }
    const totals=(await query(`SELECT count(*)::int chunks,coalesce(sum(row_count),0)::int rows,
      coalesce(sum(raw_bytes),0)::bigint "rawBytes",coalesce(sum(octet_length(payload)),0)::bigint "compressedBytes"
      FROM event_archives WHERE preview_id=$1`,[preview.id])).rows[0];
    return {...totals,previewId:preview.id,sourceRowsPreserved:true};
  }
  async function restore({task,checkpoint,workerId}){
    await checkpoint({step:'restoring'});
    return transaction(async c=>{
      await lockTask(c,task,workerId);
      const a=(await c.query('SELECT * FROM event_archives WHERE id=$1 FOR UPDATE',[task.parameters.archiveId])).rows[0];
      if(!a)throw fail('Archive not found');
      if(a.restored_at)return a.restore_result;
      const value=await decodeArchive(a),table=archiveTables[a.stream];
      const ids=[...new Set(value.records.map(r=>r.user_id).filter(Boolean))];
      const users=new Set((await c.query('SELECT id FROM users WHERE id=ANY($1::uuid[])',[ids])).rows.map(r=>r.id));
      let missingUsers=0;const records=[];
      for(const row of value.records){
        if(row.user_id&&!users.has(row.user_id)){missingUsers++;if(a.stream==='product')continue;records.push({...row,user_id:null});}
        else records.push(row);
      }
      const json=JSON.stringify(records);
      const conflict=(await c.query(`SELECT 1 FROM jsonb_populate_recordset(NULL::${table},$1) x JOIN ${table} e USING(id)
        WHERE to_jsonb(e)<>to_jsonb(x) LIMIT 1`,[json])).rowCount;
      if(conflict)throw fail('Existing event differs; restore stopped','ARCHIVE_CONFLICT');
      const result=await c.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1) ON CONFLICT(id) DO NOTHING`,[json]);
      const summary={inserted:result.rowCount,alreadyPresent:records.length-result.rowCount,missingUsers,
        skippedDeletedUsers:a.stream==='product'?missingUsers:0,anonymizedDeletedUsers:a.stream==='operation'?missingUsers:0};
      await c.query('UPDATE event_archives SET restored_at=now(),restore_task_id=$2,restore_result=$3,version=version+1 WHERE id=$1',[a.id,task.id,summary]);
      await audit(task,'events.restored',a.id,summary,c);await lockTask(c,task,workerId);return summary;
    });
  }
  async function dailyRollup({task,checkpoint,workerId}){
    const range=archiveWindow(task.parameters);
    let days=0;
    for(let d=new Date(range.start);d<new Date(range.end);d.setTime(d.getTime()+dayMs)){
      await checkpoint({step:'summarizing',days});
      days+=await transaction(async c=>{await lockTask(c,task,workerId);const n=await rollupDays(c,{from:day(d),to:day(d)});await lockTask(c,task,workerId);return n;});
    }
    return {days,from:range.from,to:range.to,dailyDistinctOnly:true};
  }
  return {event_archive:eventArchive,archive_restore:restore,daily_rollup:dailyRollup};
}
