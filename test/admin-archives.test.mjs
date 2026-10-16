import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installArchiveRoutes} from '../server/operations/archive-routes.mjs';
import {archiveExecutors,archiveWindow,decodeArchive,archiveMaxBytes,lockTask} from '../server/operations/event-archive.mjs';
import {installMaintenance} from '../server/operations/maintenance.mjs';
import {installAnalytics} from '../server/operations/analytics.mjs';
import {archivedUserStats,archivedRequests,requireRawCoverage} from '../server/operations/archive-coverage.mjs';

const dateAgo=n=>new Date(Date.now()-n*86400000+8*3600000).toISOString().slice(0,10);
test('archive bounded decoder and date validation',async()=>{
  const bytes=Buffer.from(JSON.stringify({version:1,stream:'operation',records:[]}));
  const row={payload:gzipSync(bytes),raw_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),stream:'operation',row_count:0};
  assert.equal((await decodeArchive(row)).version,1);
  await assert.rejects(decodeArchive({...row,sha256:'0'.repeat(64)}),{code:'ARCHIVE_INVALID'});
  await assert.rejects(decodeArchive({...row,payload:gzipSync(Buffer.alloc(archiveMaxBytes+1))}),{code:'ARCHIVE_INVALID'});
  assert.throws(()=>archiveWindow({from:dateAgo(40),to:dateAgo(1)}));
  assert.throws(()=>archiveWindow({from:dateAgo(0),to:dateAgo(0)}));
});

test('archive permission, atomic move, resumability, restore and honest analytics',{skip:process.env.TEST_OPERATIONS!=='1',timeout:90000},async t=>{
  const schemas=['schema.sql','citywalk-schema.sql','agent/schema.sql','operations/inbox-schema.sql','citywalk-expansion-schema.sql','operations/product-schema.sql','operations/analytics-schema.sql','operations/maintenance-schema.sql','operations/archive-schema.sql'];
  const f=await iterationFixture({schemas});
  let rejectChunk=0,chunkCalls=0;
  const events={...f.events,append:async(...args)=>{if(args[0].action==='events.archived'&&++chunkCalls===rejectChunk)throw Error('audit failure');return f.events.append(...args);}};
  const m=installMaintenance(f.app,{...f,events,extraExecutors:archiveExecutors({...f,events})});
  installArchiveRoutes(f.app,{...f,events});installAnalytics(f.app,f);
  f.app.use((err,req,res,next)=>{if(!err.status&&err.name!=='ZodError')console.error('Archive fixture:',err.message);next(err);});
  const root='/api/admin/archives',day=dateAgo(100),range={from:day,to:day};
  const old=day+'T03:04:05.123456+08:00',requestId=randomUUID(),bigId='9007199254740993';
  const task=id=>f.query('SELECT * FROM maintenance_tasks WHERE id=$1',[id]).then(r=>r.rows[0]);
  const preview=async(stream='operation',extra={})=>f.request(root+'/preview',{body:{id:randomUUID(),stream,...range,...extra}});
  const start=async(previewId,id=randomUUID())=>f.request(root+'/start',{body:{id,previewId,confirmation:'archive-events'}});
  const restore=async(a,extra={})=>f.request(root+'/'+a.id+'/restore',{body:{id:randomUUID(),version:a.version,sha256:a.sha256,confirmation:'restore-events',...extra}});
  const archives=async()=> (await f.request(root)).data.items;
  let pid,job,packages;
  try{
    await f.query('UPDATE users SET created_at=$1',[dateAgo(200)]);
    await f.query('UPDATE analytics_settings SET started_at=$1',[dateAgo(200)]);
    await f.query(`INSERT INTO operation_events(user_id,kind,action,request_id,created_at) SELECT $1,'navigation','home.open',$2,$3 FROM generate_series(1,501)`,[f.users.user.id,requestId,old]);
    await f.query("INSERT INTO operation_events(id,user_id,kind,action,created_at) VALUES($1,$2,'request','GET /api/trips',$3)",[bigId,f.users.user.id,old]);
    await f.query("INSERT INTO operation_events(user_id,kind,action,created_at) VALUES($1,'admin','protected.audit',$2)",[f.users.admin.id,old]);
    await f.query("INSERT INTO product_events(user_id,event_type,resource_type,resource_id,request_id,source,created_at) VALUES($1,'trip.saved','trip','fixture-trip',$2,'database',$3)",[f.users.user.id,requestId,old]);
    await f.start();
    await t.test('AR01 authorization, safe range and idempotent preview at Beijing day boundary',async()=>{
      for(const user of [null,'user'])assert.equal((await f.request(root,{user})).status,user?403:401);
      const p=await f.request(root+'/policy');assert.equal(p.data.automaticArchiving,false);assert.equal(p.data.raw_retention_days,90);
      assert.equal((await preview('operation',{from:dateAgo(1),to:dateAgo(1)})).status,400);
      const id=randomUUID(),body={id,stream:'operation',...range};
      const responses=await Promise.all(Array.from({length:20},()=>f.request(root+'/preview',{body})));
      for(const r of responses){assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.rows,502);}
      pid=id;
      assert.equal((await f.request(root+'/preview',{body:{...body,stream:'product'}})).status,409);
      assert.equal((await f.query('SELECT count(*)::int n FROM event_archive_previews WHERE id=$1',[id])).rows[0].n,1);
      assert.equal((await f.request('/api/admin/analytics/overview?'+new URLSearchParams(range))).data.totals.active,1);
    });
    await t.test('AR02 enqueue replay and a failed second chunk preserve committed progress and raw rows',async()=>{
      const id=randomUUID();const replies=await Promise.all(Array.from({length:20},()=>start(pid,id)));
      for(const r of replies){assert.equal(r.status,202,JSON.stringify(r.data));assert.equal(r.data.id,id);}job=id;
      rejectChunk=2;await m.worker.tick();
      assert.equal((await task(id)).state,'failed');assert.equal((await task(id)).error_code,'TASK_FAILED');
      packages=await archives();assert.equal(packages.length,1);assert.equal(packages[0].row_count,500);
      assert.equal((await f.query('SELECT processed_count FROM event_archive_previews WHERE id=$1',[pid])).rows[0].processed_count,500);
      assert.equal((await f.query("SELECT count(*)::int n FROM operation_events WHERE user_id=$1 AND created_at=$2",[f.users.user.id,old])).rows[0].n,2);
      assert.equal((await f.query("SELECT count(*)::int n FROM operation_events WHERE action='protected.audit'")).rows[0].n,1);
    });
    await t.test('AR03 retry only unprocessed IDs, preserve all 502 events and microsecond/bigint values',async()=>{
      rejectChunk=0;const previous=await task(job);
      const r=await f.request('/api/admin/maintenance/tasks/'+job+'/retry',{body:{id:randomUUID(),version:previous.version,confirmation:'retry-task'}});
      assert.equal(r.status,202,JSON.stringify(r.data));await m.worker.tick();assert.equal((await task(r.data.id)).state,'completed');
      packages=await archives();assert.equal(packages.length,2);assert.equal(packages.reduce((n,a)=>n+a.row_count,0),502);
      let all=[];
      for(const a of packages){const d=await f.request(root+'/'+a.id+'/download');assert.equal(d.status,200);all.push(...JSON.parse(gunzipSync(d.data)).records);}
      assert.equal(new Set(all.map(r=>r.id)).size,502);assert.ok(all.some(r=>r.id===bigId));assert.ok(all.every(r=>r.created_at.includes('123456')));
      const s=await archivedUserStats(f.query,f.users.user.id);assert.equal(s.count,502);assert.equal(new Date(s.last_activity_at).getTime(),new Date(old).getTime());
      assert.equal((await f.request('/api/admin/users/'+f.users.user.id)).data.user.operation_count,502);
    });
    await t.test('AR04 archived ranges and IDs never silently become empty; frozen daily aggregates are available',async()=>{
      const params=new URLSearchParams(range);
      for(const endpoint of ['/api/admin/events','/api/admin/events/export','/api/admin/analytics/overview','/api/admin/analytics/funnels','/api/admin/analytics/retention','/api/admin/analytics/segments'])assert.equal((await f.request(endpoint+'?'+params)).status,409,endpoint);
      assert.equal((await f.request('/api/admin/events/'+bigId)).status,409);
      const r=await f.request('/api/admin/analytics/daily-archives?'+params);assert.equal(r.status,200);assert.equal(r.data.items[0].metrics.active,1);assert.equal(r.data.items[0].metrics.operations,503);assert.equal(r.data.items[0].frozen,true);
      await requireRawCoverage(f.query,range.from,range.to,{userId:f.users.other.id});
    });
    await t.test('AR05 checksum and conflicting IDs block restore without overwriting existing rows',async()=>{
      const a=packages.find(x=>x.row_count===2),stored=(await f.query('SELECT * FROM event_archives WHERE id=$1',[a.id])).rows[0],records=(await decodeArchive(stored)).records;
      const conflict=records[0];await f.query('INSERT INTO operation_events SELECT * FROM jsonb_populate_recordset(NULL::operation_events,$1)',[JSON.stringify([{...conflict,action:'preserve-this-current-event'}])]);
      assert.equal((await restore(a,{sha256:'0'.repeat(64)})).status,409);
      const r=await restore(a);await m.worker.tick();assert.equal((await task(r.data.id)).error_code,'ARCHIVE_CONFLICT');
      assert.equal((await f.query('SELECT action FROM operation_events WHERE id=$1',[conflict.id])).rows[0].action,'preserve-this-current-event');
      assert.equal((await f.query('SELECT restored_at FROM event_archives WHERE id=$1',[a.id])).rows[0].restored_at,null);
      await f.query('DELETE FROM operation_events WHERE id=$1',[conflict.id]);
    });
    await t.test('AR06 restore replay preserves original timestamps and removes false archive coverage',async()=>{
      for(const a of packages){const r=await restore(a);assert.equal(r.status,202);await m.worker.tick();assert.equal((await task(r.data.id)).state,'completed');const again=await restore(a);assert.equal(again.data.id,r.data.id);}
      assert.equal((await archivedUserStats(f.query,f.users.user.id)).count,0);
      assert.equal((await f.request('/api/admin/analytics/overview?'+new URLSearchParams(range))).data.totals.active,1);
      assert.equal((await f.query('SELECT count(*)::int n FROM operation_events WHERE user_id=$1 AND created_at=$2',[f.users.user.id,old])).rows[0].n,502);
      assert.equal((await f.query('SELECT id::text FROM operation_events WHERE id=$1',[bigId])).rows[0].id,bigId);
    });
    await t.test('AR07 deleted users are not resurrected by business-event restore',async()=>{
      const p=await preview('product');const r=await start(p.data.id);await m.worker.tick();assert.equal((await task(r.data.id)).state,'completed');
      assert.equal(await archivedRequests(f.query,f.users.user.id,[requestId]),true);
      const a=(await archives()).find(x=>x.stream==='product');await f.query('DELETE FROM users WHERE id=$1',[f.users.user.id]);
      const restoreTask=await restore(a);await m.worker.tick();const done=await task(restoreTask.data.id);
      assert.equal(done.state,'completed');assert.equal(done.result.skippedDeletedUsers,1);assert.equal(done.result.inserted,0);
      assert.equal((await f.query('SELECT count(*)::int n FROM users WHERE id=$1',[f.users.user.id])).rows[0].n,0);
    });
    await t.test('AR08 expired execution lease fails the transaction fence',async()=>{
      const id=randomUUID(),worker=randomUUID();await f.query("INSERT INTO maintenance_tasks(id,kind,state,worker_id,lease_until) VALUES($1,'daily_rollup','running',$2,now()-interval '1 second')",[id,worker]);
      await assert.rejects(f.transaction(c=>lockTask(c,{id},worker)),{code:'LEASE_LOST'});
      await f.query("UPDATE maintenance_tasks SET state='interrupted' WHERE id=$1",[id]);
    });
    await t.test('AR09 archive metadata pressure remains paginated and never exposes blob/user index',async()=>{
      let index=0;const times=[];await Promise.all(Array.from({length:8},async()=>{while(index++<120){const begin=performance.now(),r=await f.request(root);assert.equal(r.status,200);assert.ok(r.data.items.every(x=>!('payload' in x)&&!('user_index' in x)));times.push(performance.now()-begin);}}));
      times.sort((a,b)=>a-b);console.log('PRESSURE archives: 120 requests/concurrency 8, p95='+Math.round(times[Math.floor(times.length*.95)])+'ms');
    });
  }finally{await m.close();await f.close();}
});
