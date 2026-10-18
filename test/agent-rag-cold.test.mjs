import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createKnowledge} from '../server/agent/knowledge.mjs';
import {embedNames,disposeEmbedding} from '../server/integrations/embedding.mjs';
import {iterationFixture} from './helpers/iteration-db.mjs';

test('cold BGE RAG requests stay within a measured memory envelope',{skip:process.env.TEST_RAG_LIVE!=='1',timeout:120000},async()=>{
 const f=await iterationFixture({schemas:['schema.sql','agent/schema.sql']});
 let batches=0;const report={at:new Date().toISOString(),scope:'isolated local CPU process, empty document-vector cache; excludes HTTP app/PostgreSQL/browser memory',concurrency:8};
 try{
  const rag=createKnowledge({query:f.query,enabled:()=>false,embed:async texts=>{if(texts.length>1)batches++;return embedNames(texts);}});
  const start=performance.now();const results=await Promise.all(Array.from({length:8},async(_,i)=>{
   const t=performance.now(),answer=await rag.answer(i%2?'怎样修改保存的行程':'收藏会影响下一次旅行问卷吗？');
   return {ms:Math.round(performance.now()-t),mode:answer.retrieval,sources:answer.sources.length};
  }));
  Object.assign(report,{elapsedMs:Math.round(performance.now()-start),documentEmbeddingBatches:batches,peakRssMiB:Math.round(process.resourceUsage().maxRSS/1024),heapMiB:Math.round(process.memoryUsage().heapUsed/1048576),results});
  assert.ok(results.every(r=>r.mode==='hybrid_bge'&&r.sources>0));
  assert.ok(report.peakRssMiB<500,'cold RAG leaves at least 140 MiB below the present 640 MiB container limit; actual full service needs separate acceptance');
  assert.ok(Math.max(...results.map(r=>r.ms))<10000,'local cold responses should not exceed 10 seconds');
 }finally{
  await mkdir('validation/personalization',{recursive:true});await writeFile('validation/personalization/rag-cold.json',JSON.stringify(report,null,2));
  await disposeEmbedding();await f.close();
 }
});
