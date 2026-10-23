/* 检查本地地点资料和天气查询流程。 */

import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
if(process.argv.slice(2).join(' ')!=='--local --live')throw Error('Use --local --live for the bounded real-provider acceptance');
dotenv.config({quiet:true});
const cfg=JSON.parse(await readFile(new URL('../.runtime/local.json',import.meta.url)));
process.env.DATABASE_URL=`postgresql://seatraces:${encodeURIComponent(cfg.password)}@127.0.0.1:${cfg.port}/seatraces`;
const {iterationFixture}=await import('../test/helpers/iteration-db.mjs');
const {createCandidateService}=await import('../server/services/place-candidates.mjs');
const {semanticRanking}=await import('../server/services/semantic-ranking.mjs');
const {createWeatherService,installWeatherRoutes}=await import('../server/services/weather.mjs');
const {amap}=await import('../server/integrations/amap.mjs');
const {createKnowledge}=await import('../server/agent/knowledge.mjs');
const {disposeEmbedding}=await import('../server/integrations/embedding.mjs');
const {pool}=await import('../server/db.mjs');
const f=await iterationFixture({schemas:['schema.sql','weather-schema.sql','agent/schema.sql']});
const report={at:new Date().toISOString(),scope:'local isolated PostgreSQL + real existing CPU BGE + read-only OSM + one budgeted Amap weather request',cases:[],mapCalls:0,modelCalls:0,modelDownloads:0};
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const point={q:'衢州孔庙',city:'衢州',countryCode:'CN',lat:28.96,lng:118.875,radius:3000,category:'scenic',intent:'named',fallback:'never'};
async function check(name,fn){const t=performance.now();const detail=await fn();report.cases.push({name,ms:Math.round(performance.now()-t),...detail});}
try{
 const service=createCandidateService({env:{...process.env,EMBEDDING_ENABLED:'true'}});
 f.app.post('/api/catalog/candidates',f.auth,async(req,res)=>res.json(await service(req.body)));
 const weather=createWeatherService({query:f.query,call:async(...args)=>{if(++report.mapCalls>1)throw Error('Acceptance exceeded its one-call weather bound');return amap(...args);}});
 installWeatherRoutes(f.app,{auth:f.auth,query:f.query,service:weather});
 const trip=randomUUID(),city={id:'weather-acceptance-shanghai',name:'上海',adcode:'310101',country:'CN',lat:31.23,lng:121.47};
 await f.query("INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,'天气隔离验收','{}',$3)",[trip,f.users.user.id,{cities:[city],days:[{cityId:city.id,date:today,stops:[]},{cityId:city.id,date:'2099-01-01',stops:[]}]}]);
 await f.start();const endpoint='/api/catalog/candidates',weatherPath='/api/journey/trips/'+trip+'/weather';
 await check('semantic name substitution',async()=>{
  const r=await f.request(endpoint,{user:'user',body:point});assert.equal(r.status,200);
  report.semanticDiagnostic={status:r.data.status,local:r.data.local,embedding:r.data.embedding,spatialRecall:r.data.spatialRecall};
  assert.equal(r.data.selection.resolvedName,'孔氏南宗家庙');assert.equal(r.data.selection.identityVerified,false);
  assert.ok(r.data.items[0].match.semanticSimilarity>=.65);assert.ok(r.data.embedding.some(s=>s.status==='ready'));assert.equal(r.data.fallback.requests,0);
  return {resolvedName:r.data.selection.resolvedName,similarity:r.data.items[0].match.semanticSimilarity,embedding:r.data.embedding.map(e=>({stage:e.stage,status:e.status})),paidCalls:r.data.fallback.requests};
 });
 await check('authentication and invalid query',async()=>{
  assert.equal((await f.request(endpoint,{user:null,body:point})).status,401);
  assert.equal((await f.request(endpoint,{user:'user',body:{...point,radius:-1}})).status,400);return {passed:true};
 });
 await check('real forecast, cache, far-future and ownership',async()=>{
  assert.equal((await f.request(weatherPath,{user:'other'})).status,404);
  const r=await f.request(weatherPath,{user:'user'});assert.equal(r.status,200);assert.equal(r.data.status,'available');assert.ok(r.data.forecast);assert.equal(r.data.provider,'amap');
  assert.equal((await f.request(weatherPath,{user:'user'})).data.status,'available');assert.equal(report.mapCalls,1);
  assert.equal((await f.request(weatherPath+'?day=1',{user:'user'})).data.status,'outside_forecast_range');assert.equal(report.mapCalls,1);
  return {provider:r.data.provider,forecastDate:r.data.forecast.date,reportedAt:r.data.reportedAt,paidCalls:report.mapCalls};
 });
 await check('bounded semantic load and existing RAG share the same encoder',async()=>{
  const knowledge=createKnowledge({query:f.query,enabled:()=>false});
  const answers=await Promise.all([knowledge.search('收藏会影响下一次旅行问卷吗？'),...Array.from({length:4},()=>f.request(endpoint,{user:'user',body:point}))]);
  assert.equal(answers[0].mode,'hybrid_bge');assert.ok(answers.slice(1).every(r=>r.status===200));
  const statuses=answers.slice(1).flatMap(r=>r.data.embedding.map(e=>e.status));
  const worst=await semanticRanking(point,Array.from({length:60},(_,i)=>({id:'public-sample-'+i,name:['孔氏南宗家庙','衢州博物馆','水亭门历史文化街区'][i%3],location:{city:'衢州'}})));
  assert.equal(worst.status,'ready');assert.equal(worst.items.length,60);
  return {rag:answers[0].mode,concurrentCandidateRequests:4,statuses,worstCaseCandidates:60};
 });
 report.status='passed';
}catch(error){report.status='failed';report.failure=error.code||error.name;throw error;}
finally{
 report.peakRssMiB=Math.round(process.resourceUsage().maxRSS/1024);report.heapMiB=Math.round(process.memoryUsage().heapUsed/1048576);
 await mkdir('validation/place-weather',{recursive:true});await writeFile('validation/place-weather/local-live.json',JSON.stringify(report,null,2));
 await disposeEmbedding();await f.close();await pool.end();console.log(JSON.stringify(report,null,2));
}
