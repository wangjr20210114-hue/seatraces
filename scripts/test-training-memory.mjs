// Worst-shaped bounded read: real requests have 120 candidates, unlike the
// single-candidate demo fixture. Parent owns cleanup even if worker hits OOM.
import {fork} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {iterationFixture} from '../test/helpers/iteration-db.mjs';
import {trainingSamples} from '../server/recommendation/training.mjs';
import {profileVector} from '../server/recommendation/features.mjs';
import {trainRecommendations} from '../server/recommendation/training.mjs';
if(process.argv[2]==='--worker'){
 const schema=process.argv[3];if(!/^iteration_[0-9a-f]{16}$/.test(schema))throw Error('Invalid test schema');
 const cfg=JSON.parse(await readFile(new URL('../.runtime/local.json',import.meta.url),'utf8'));
 const pool=new pg.Pool({host:'127.0.0.1',port:cfg.port,user:'seatraces',password:cfg.password,database:'seatraces',max:1,options:`-c search_path=${schema},public`});
 let bytes=0,pages=0,maxPageRows=0,peakHeap=0;
 const sample=()=>{peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);},timer=setInterval(sample,20);
 const query=async(sql,args)=>{const result=await pool.query(sql,args);if(sql.startsWith('WITH page AS MATERIALIZED')){pages++;maxPageRows=Math.max(maxPageRows,result.rows.length);bytes+=Buffer.byteLength(JSON.stringify(result.rows));}sample();return result;};
 const transaction=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 try{const start=performance.now();let samples,models;
  if(process.argv.includes('--train')){const r=await trainRecommendations({query,transaction,scope:'real',activate:false});if(r.status!=='evaluated')throw Error('Full training did not finish: '+r.status);samples=r.models[0].metrics.counts.total;models=r.models.map(m=>({kind:m.kind,state:m.state,counts:m.metrics.counts,eligible:m.metrics.eligible}));}
  else samples=(await trainingSamples(query,'real')).length;
  sample();process.send({samples,models,pages,maxPageRows,serializedReturnedBytes:bytes,elapsedMs:Math.round(performance.now()-start),peakRssMiB:Math.round(process.resourceUsage().maxRSS/1024),sampledPeakHeapMiB:Math.round(peakHeap/1048576),heapMiB:Math.round(process.memoryUsage().heapUsed/1048576)});
 }finally{clearInterval(timer);await pool.end();process.disconnect();}
}else{
 const countArg=process.argv.indexOf('--samples'),count=countArg<0?6000:Number(process.argv[countArg+1]),train=process.argv.includes('--train');
 if(![6000,20000,20100].includes(count))throw Error('Use --samples 6000, 20000 or 20100');
 const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','agent/schema.sql','social/schema.sql','social/style-schema.sql','recommendation/schema.sql']});
 const report={at:new Date().toISOString(),scope:'disposable schema, separate 320 MiB old-space worker',productionAccess:false,candidatesPerRequest:120,inputExposures:count,expectedSamples:Math.min(count,20000),mode:train?'full CPU training':'read only'};
 try{
  await f.query("INSERT INTO users(id,username,password_hash,nickname) SELECT gen_random_uuid(),'memory_reader_'||n,'!disabled','隔离读取账号'||n FROM generate_series(1,$1::int) n",[Math.ceil(count/100)]);
  await f.query("INSERT INTO posts(id,user_id,title,body,tags,snapshot,created_at) SELECT gen_random_uuid(),$1,'读取测试'||n,'测试','{}','{}',now()-interval '60 days' FROM generate_series(1,120) n",[f.users.other.id]);
  const vector=profileVector({}, {interests:['人文']}),ids=(await f.query('SELECT id FROM posts ORDER BY id')).rows.map(r=>r.id);
  const parts={coarse:.4,affinity:.2,author:0,fresh:.3,quality:.4,city:0,seen:0,tower:0};
  const trace={items:ids.map((id,i)=>({id,revision:1,channels:['content','fresh','interest'],coarse:.4,fine:.6,parts,reason:i%5===4?'fresh_exploration':'relevance_and_diversity'}))};
  await f.query("INSERT INTO recommendation_requests(id,user_id,profile_version,user_vector,context,candidate_ids,trace,algorithm,created_at) SELECT gen_random_uuid(),id,0,$1,'{}',$2,$3,'memory-test',now()-interval '210 days' FROM users WHERE username LIKE 'memory_reader_%'",[vector,ids,trace]);
  await f.query(`INSERT INTO social_impressions(id,user_id,post_id,context,visible_ms,created_at)
   SELECT gen_random_uuid(),u.id,p.id,'feed',5000,now()-interval '20 days' - CASE WHEN $2 THEN floor((row_number() OVER(ORDER BY u.id,p.id)-1)*180.0/$1)*interval '1 day' ELSE interval '0 days' END
   FROM users u CROSS JOIN (SELECT id FROM posts ORDER BY id LIMIT 100) p WHERE u.username LIKE 'memory_reader_%' ORDER BY u.id,p.id LIMIT $1`,[count,train]);
  await f.query('INSERT INTO recommendation_exposures(id,request_id,user_id,post_id,position,item_vector,visible_ms,created_at) SELECT s.id,r.id,s.user_id,s.post_id,array_position(r.candidate_ids,s.post_id)-1,$1,s.visible_ms,s.created_at FROM social_impressions s JOIN recommendation_requests r ON r.user_id=s.user_id',[vector]);
  if(train)await f.query(`INSERT INTO recommendation_outcomes(user_id,post_id,kind,active,occurred_at)
   SELECT user_id,post_id,'save',true,created_at+interval '1 hour' FROM (SELECT e.*,row_number() OVER(ORDER BY user_id,post_id) n FROM recommendation_exposures e) x WHERE n%2=0`);
  report.serializedFullTraceBytes=Number((await f.query("SELECT sum(octet_length((r.trace->'items')::text)) n FROM recommendation_exposures e JOIN recommendation_requests r ON r.id=e.request_id")).rows[0].n);
  const child=fork(fileURLToPath(import.meta.url),['--worker',f.schema,...(train?['--train']:[])],{execArgv:['--max-old-space-size=320','--max-semi-space-size=8'],windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b).slice(-12000);});child.on('message',m=>{report.worker=m;});
  const timer=setTimeout(()=>child.kill(),240000);const result=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));clearTimeout(timer);report.exit=result;report.heapFailure=/heap out of memory|Reached heap limit/.test(stderr);
  report.passed=result.code===0&&report.worker?.samples===report.expectedSamples&&report.worker.maxPageRows<=500&&report.worker.sampledPeakHeapMiB<240&&report.worker.peakRssMiB<400;
  if(!report.passed)report.errorTail=stderr.slice(-2000);
  if(!report.passed)process.exitCode=1;
 }finally{await f.close();report.schemaRemoved=true;await mkdir('reports/recommendation',{recursive:true});await writeFile('reports/recommendation/training-memory-'+count+(train?'-train':'')+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
}
