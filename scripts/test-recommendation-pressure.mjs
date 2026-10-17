// Two processes: load generator and constrained Node service. Isolated local
// schema only; no production requests, user data or paid model/map calls.
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {getHeapStatistics} from 'node:v8';
import assert from 'node:assert/strict';
import {iterationFixture} from '../test/helpers/iteration-db.mjs';
import {backfillItems,buildProfile} from '../server/recommendation/profiles.mjs';
import {recommend} from '../server/recommendation/engine.mjs';
import {installSocialCommunity} from '../server/social/community.mjs';

const reportPath='reports/recommendation/strict-pressure.json';
if(process.argv.includes('--worker')){
 let f,timer;const loop=monitorEventLoopDelay({resolution:20});let peakHeap=0,peakRss=0;
 try{
  f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','agent/schema.sql','social/schema.sql','social/style-schema.sql','recommendation/schema.sql']});
  await f.query(`INSERT INTO users(id,username,password_hash,nickname) SELECT gen_random_uuid(),'pressure_author_'||n,'!disabled','隔离压力作者'||n FROM generate_series(1,50) n`);
  await f.query(`WITH authors AS (SELECT id,row_number() OVER(ORDER BY id)-1 n FROM users WHERE username LIKE 'pressure_author_%')
   INSERT INTO posts(id,user_id,title,body,tags,snapshot,created_at)
   SELECT gen_random_uuid(),a.id,CASE WHEN g.n%2=0 THEN '博物馆历史路线' ELSE '公园自然散步' END||g.n,repeat('隔离合成内容 ',80),ARRAY[CASE WHEN g.n%2=0 THEN '人文' ELSE '自然' END],
    jsonb_build_object('cities',jsonb_build_array(CASE WHEN g.n%3=0 THEN '北京' ELSE '上海' END),'days',jsonb_build_array(jsonb_build_object('stops',jsonb_build_array(jsonb_build_object('id','pressure-place-'||g.n,'name','测试博物馆','category','attraction','lat',39.9,'lng',116.4))))),now()-g.n*interval '3 hours'
   FROM generate_series(1,2000) g(n) JOIN authors a ON a.n=g.n%50`);
  await backfillItems(f.query);await f.query("INSERT INTO reactions(user_id,post_id,kind) SELECT $1,id,'save' FROM posts ORDER BY id LIMIT 180",[f.users.user.id]);await f.transaction(c=>buildProfile(c,f.users.user.id));
  installSocialCommunity(f.app,{...f,recommend:(u,o)=>recommend(f.query,u,o)});const port=await f.start();
  loop.enable();timer=setInterval(()=>{const m=process.memoryUsage();peakHeap=Math.max(peakHeap,m.heapUsed);peakRss=Math.max(peakRss,m.rss);},20);
  process.send({type:'ready',port,cookie:f.users.user.cookie,heapLimitMiB:getHeapStatistics().heap_size_limit/1048576});
  process.on('message',async msg=>{
   try{
    if(msg.type==='stats'){
     global.gc?.();const m=process.memoryUsage();process.send({type:'stats',nonce:msg.nonce,heapMiB:m.heapUsed/1048576,rssMiB:m.rss/1048576,peakHeapMiB:peakHeap/1048576,peakRssMiB:peakRss/1048576,loopP99Ms:loop.percentile(99)/1e6,
      requests:Number((await f.query('SELECT count(*) n FROM recommendation_requests WHERE user_id=$1',[f.users.user.id])).rows[0].n),feeds:Number((await f.query('SELECT count(*) n FROM social_feed_sessions WHERE user_id=$1',[f.users.user.id])).rows[0].n)});loop.reset();
    }else if(msg.type==='close'){clearInterval(timer);loop.disable();await f.close();process.send({type:'closed',schemaRemoved:true});process.disconnect();}
   }catch(e){process.send({type:'error',message:e.message});}
  });
 }catch(e){clearInterval(timer);loop.disable();await f?.close();process.send?.({type:'error',message:e.message});process.disconnect?.();process.exitCode=1;}
}else{
 const out={version:'recommendation-pressure/2',at:new Date().toISOString(),scope:'separate service process; isolated local PostgreSQL schema',posts:2000,authors:50,paidCalls:0,productionAccess:false,rounds:[]};
 const worker=fork(fileURLToPath(import.meta.url),['--worker'],{execArgv:['--max-old-space-size=320','--max-semi-space-size=8','--expose-gc'],windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 let stderr='';worker.stderr.on('data',b=>{stderr=(stderr+b).slice(-4000);});worker.stdout.resume();
 const wait=(type,timeout=180000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>done(Error('Worker timeout: '+type)),timeout);const message=m=>{if(m.type==='error')done(Error(m.message));else if(m.type===type)done(null,m);};const exited=code=>done(Error('Worker exited '+code));function done(e,v){clearTimeout(timer);worker.off('message',message);worker.off('exit',exited);e?reject(e):resolve(v);}worker.on('message',message);worker.on('exit',exited);});
 try{
  const ready=await wait('ready');out.heapLimitMiB=Math.round(ready.heapLimitMiB);
  for(let round=0;round<5;round++){
   const n=round===0?40:160,concurrency=round===0?4:16;let next=0;const times=[],sizes=[],errors=[],start=performance.now();
   await Promise.all(Array.from({length:concurrency},async()=>{while(next++<n){const started=performance.now();try{
    const response=await fetch('http://127.0.0.1:'+ready.port+'/api/social/feed?limit=12',{headers:{Cookie:ready.cookie},signal:AbortSignal.timeout(30000)}),raw=await response.text();sizes.push(Buffer.byteLength(raw));assert.equal(response.status,200);const body=JSON.parse(raw);assert.ok(body.items.length<=12);assert.equal(new Set(body.items.map(i=>i.id)).size,body.items.length);assert.ok(body.requestId);assert.ok(!raw.includes('user_vector')&&!raw.includes('password_hash'));
   }catch(e){errors.push(e.message);}finally{times.push(performance.now()-started);}}}));
   times.sort((a,b)=>a-b);const pending=wait('stats');worker.send({type:'stats',nonce:round});const stats=await pending;
   out.rounds.push({round,requests:n,concurrency,errors:errors.length,errorExamples:errors.slice(0,3),elapsedMs:Math.round(performance.now()-start),p50Ms:Math.round(times[Math.floor(n*.5)]),p95Ms:Math.round(times[Math.floor(n*.95)]),maxMs:Math.round(times.at(-1)),maxResponseBytes:Math.max(...sizes),...Object.fromEntries(Object.entries(stats).filter(([k])=>!['type','nonce','requests'].includes(k))),storedRequests:stats.requests});
   console.log(JSON.stringify(out.rounds.at(-1)));assert.equal(errors.length,0);assert.ok(stats.requests<=400);assert.ok(stats.feeds<=6);
  }
  out.heapGrowthMiB=out.rounds.at(-1).heapMiB-out.rounds[0].heapMiB;
  out.thresholds={p95Ms:5000,maxAfterGcGrowthMiB:24,maxPeakHeapMiB:240};
  out.functionalPassed=out.rounds.every(r=>r.errors===0);out.performancePassed=out.rounds.every(r=>r.p95Ms<5000&&r.peakHeapMiB<240)&&out.heapGrowthMiB<24;
  // Performance failures are evidence for a separate proposed optimization,
  // not permission to silently change indexes/caches/data structures.
  if(!out.performancePassed)process.exitCode=1;
 }catch(e){out.error=e.message;out.stderr=stderr;out.functionalPassed=false;process.exitCode=1;
 }finally{
  if(worker.connected){const closed=wait('closed',30000);worker.send({type:'close'});try{out.schemaRemoved=(await closed).schemaRemoved;}catch(e){out.cleanupError=e.message;worker.kill();process.exitCode=1;}}
  await mkdir('reports/recommendation',{recursive:true});await writeFile(reportPath,JSON.stringify(out,null,2));console.log(reportPath);
 }
}
