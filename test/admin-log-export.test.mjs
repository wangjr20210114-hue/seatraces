/* 验证日志导出任务。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {gunzipSync,createGunzip} from 'node:zlib';
import {Readable,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {createLogExportService,exportLimits,captureLogSelection} from '../server/operations/log-export.mjs';
import {createMaintenanceWorker} from '../server/operations/maintenance-worker.mjs';

test('durable log exports: snapshot, isolation, replay, interruption and bounded volume',{skip:process.env.TEST_OPERATIONS!=='1',timeout:120000},async t=>{
 const f=await iterationFixture({schemas:['operations/maintenance-schema.sql','operations/log-exports-schema.sql']});
 const service=createLogExportService(f),worker=createMaintenanceWorker({...f,executors:{log_export:service.execute}}),root='/api/admin/events/exports';
 const enqueue=(id,filters={action:'fixture.export'})=>f.request(root,{body:{id,filters}});
 try{
  await f.query("INSERT INTO operation_events(user_id,kind,action,status,duration_ms) SELECT $1,'request','fixture.export',200,n FROM generate_series(1,123) n",[f.users.user.id]);await f.start();
  const id=randomUUID();
  await t.test('anonymous and ordinary users denied; accepted replay creates one task',async()=>{
   assert.equal((await f.request(root,{user:null})).status,401);assert.equal((await f.request(root,{user:'user'})).status,403);
   const results=await Promise.all(Array.from({length:12},()=>enqueue(id)));assert.ok(results.every(r=>r.status===202));
   assert.equal((await f.query('SELECT count(*)::int n FROM maintenance_tasks')).rows[0].n,1);
   assert.equal((await enqueue(randomUUID())).status,409);assert.equal((await f.request(root+'/'+id+'/file')).status,409);
   assert.equal((await enqueue(id,{action:'different'})).status,409);
  });
  await t.test('queued IDs freeze membership, background chunks survive service reconstruction',async()=>{
   await f.query("INSERT INTO operation_events(kind,action) VALUES('request','fixture.export')");
   await worker.tick();const info=await f.request(root+'/'+id);assert.equal(info.data.state,'completed');assert.equal(info.data.total_rows,123);
   const data=await f.request(root+'/'+id+'/file');assert.equal(data.status,200);const rows=gunzipSync(data.data).toString().trim().split('\n').map(JSON.parse);assert.equal(rows.length,123);assert.equal(new Set(rows.map(x=>x.id)).size,123);assert.ok(rows.every(r=>r.user_id===f.users.user.id));
   assert.ok(info.data.result.chunks>=3);assert.equal((await f.request(root)).data.items[0].id,id);
   assert.equal((await f.query('SELECT max(row_count)::int n,max(raw_bytes)::int bytes FROM admin_log_export_chunks')).rows[0].n<=50,true);
  });
  await t.test('other administrator cannot query or download another owner export',async()=>{
   await f.query("UPDATE users SET role='admin' WHERE id=$1",[f.users.other.id]);const login=await f.request('/api/auth/admin/login',{user:'other',body:{username:f.users.other.username,password:f.password}});f.users.other.cookie=login.headers.get('set-cookie').split(';')[0];
   for(const path of ['/'+id,'/'+id+'/file'])assert.equal((await f.request(root+path,{user:'other'})).status,404);
   assert.equal((await f.request(root,{user:'other'})).data.items.length,0);
  });
  await t.test('source deletion fails visibly, cleans partial data, never silently exports fewer rows',async()=>{
   const task=randomUUID();assert.equal((await enqueue(task)).status,202);await f.query("DELETE FROM operation_events WHERE id=(SELECT max(id) FROM operation_events WHERE action='fixture.export')");await worker.tick();
   assert.equal((await f.request(root+'/'+task)).data.error_code,'EXPORT_SOURCE_CHANGED');assert.equal((await f.request(root+'/'+task+'/file')).status,409);assert.equal((await f.query('SELECT count(*)::int n FROM admin_log_export_chunks WHERE export_id=$1',[task])).rows[0].n,0);
  });
  await t.test('revoked authority fails queued execution and expiration prevents downloads',async()=>{
   const task=randomUUID();await enqueue(task);await f.query('UPDATE users SET disabled_at=now() WHERE id=$1',[f.users.admin.id]);await worker.tick();assert.equal((await f.query('SELECT error_code FROM maintenance_tasks WHERE id=$1',[task])).rows[0].error_code,'EXPORT_ACCESS_REVOKED');
   await f.query('UPDATE users SET disabled_at=NULL WHERE id=$1',[f.users.admin.id]);await f.query("UPDATE admin_log_exports SET expires_at=now()-interval '1 second' WHERE id=$1",[id]);assert.equal((await f.request(root+'/'+id+'/file')).status,404);await service.cleanup();assert.equal((await f.query('SELECT count(*)::int n FROM admin_log_export_chunks WHERE export_id=$1',[id])).rows[0].n,0);
  });
  await t.test('empty selection is a valid empty gzip; lost lease is never replayed automatically',async()=>{
   const empty=randomUUID();await enqueue(empty,{action:'nothing.matches'});await worker.tick();assert.equal(gunzipSync((await f.request(root+'/'+empty+'/file')).data).length,0);
   const interrupted=randomUUID();await enqueue(interrupted);await f.query("UPDATE maintenance_tasks SET state='running',worker_id=$2,lease_until=now()-interval '1 second' WHERE id=$1",[interrupted,randomUUID()]);await worker.tick();assert.equal((await f.request(root+'/'+interrupted)).data.state,'interrupted');
  });
  await t.test('creation audit failure rolls back task and snapshot; limits reject before queuing',async()=>{
   const task=randomUUID(),append=f.events.append;
   f.events.append=async event=>{if(event.action==='logs.export_queued')throw Error('fixture audit unavailable');return append(event);};
   try{assert.equal((await enqueue(task)).status,500);}finally{f.events.append=append;}
   assert.equal((await f.query('SELECT count(*)::int n FROM maintenance_tasks WHERE id=$1',[task])).rows[0].n,0);
   assert.equal((await f.query('SELECT count(*)::int n FROM admin_log_exports WHERE id=$1',[task])).rows[0].n,0);
   await assert.rejects(()=>captureLogSelection(f.query,{action:'fixture.export'},2),{code:'EXPORT_OVERSIZE'});
   await f.query("INSERT INTO operation_events(kind,action,metadata) VALUES('request','oversize.row',jsonb_build_object('fixture',repeat('x',524288)))");
   assert.equal((await enqueue(randomUUID(),{action:'oversize.row'})).status,413);
   assert.equal((await f.query("SELECT count(*)::int n FROM maintenance_tasks WHERE state='queued'")).rows[0].n,0);
  });
  await t.test('migrations can repeat with completed export tasks still present',async()=>{
   for(const file of ['maintenance-schema.sql','archive-schema.sql','log-exports-schema.sql'])await f.query(await readFile(new URL('../server/operations/'+file,import.meta.url),'utf8'));
   assert.ok((await f.query("SELECT count(*)::int n FROM maintenance_tasks WHERE kind='log_export' AND state='completed'")).rows[0].n>0);
  });
  await t.test('cancellation after a committed chunk removes partial files and never publishes download',async()=>{
   const task=randomUUID();assert.equal((await enqueue(task)).status,202);
   const cancelling=createMaintenanceWorker({...f,executors:{log_export:args=>service.execute({...args,checkpoint:async progress=>{
    if(progress?.completedRows>0)await f.query('UPDATE maintenance_tasks SET cancel_requested=true WHERE id=$1',[task]);
    return args.checkpoint(progress);
   }})}});
   try{await cancelling.tick();}finally{await cancelling.close();}
   assert.equal((await f.request(root+'/'+task)).data.state,'cancelled');
   assert.equal((await f.request(root+'/'+task+'/file')).status,409);
   assert.equal((await f.query('SELECT count(*)::int n FROM admin_log_export_chunks WHERE export_id=$1',[task])).rows[0].n,0);
  });
  await t.test('20,001 rows export in bounded chunks while 60 interactive reads continue',async()=>{
   await f.query("INSERT INTO operation_events(kind,action,metadata) SELECT 'request','load.stream',jsonb_build_object('fixture',repeat('x',1024)) FROM generate_series(1,20001)");
   const task=randomUUID(),start=performance.now(),baseline=process.memoryUsage().heapUsed;let peak=baseline;
   const sampler=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().heapUsed);},10);
   try{
    assert.equal((await enqueue(task,{action:'load.stream'})).status,202);
    await Promise.all([worker.tick(),(async()=>{for(let i=0;i<60;i++)assert.equal((await f.request('/api/admin/events?action=fixture.export&limit=10')).status,200);})()]);
    const result=(await f.request(root+'/'+task)).data;assert.equal(result.state,'completed');assert.equal(result.result.rows,20001);
    const file=await f.request(root+'/'+task+'/file');assert.equal(file.status,200);let lines=0;
    await pipeline(Readable.from([file.data]),createGunzip(),new Writable({write(chunk,encoding,callback){for(const b of chunk)if(b===10)lines++;callback();}}));assert.equal(lines,20001);
    const largest=(await f.query('SELECT max(row_count)::int rows,max(raw_bytes)::int bytes FROM admin_log_export_chunks WHERE export_id=$1',[task])).rows[0];assert.ok(largest.rows<=50);assert.ok(largest.bytes<=exportLimits.chunkBytes);
    console.log('LOG_EXPORT_PRESSURE '+JSON.stringify({rows:lines,concurrentInteractiveReads:60,errors:0,chunks:result.result.chunks,maxChunkBytes:largest.bytes,rawBytes:result.result.rawBytes,heapPeakMB:Math.round(peak/1048576),heapIncreaseMB:Math.round((peak-baseline)/1048576),elapsedMs:Math.round(performance.now()-start)}));
   }finally{clearInterval(sampler);}
  });
 }finally{await worker.close();await f.close();}
});
