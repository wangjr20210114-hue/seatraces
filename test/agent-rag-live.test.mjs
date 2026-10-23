/* 验证AI 回答的实际资料依据。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createKnowledge } from '../server/agent/knowledge.mjs';
import { knowledge } from '../server/agent/catalog.mjs';
import { embedNames, disposeEmbedding } from '../server/integrations/embedding.mjs';
import { iterationFixture } from './helpers/iteration-db.mjs';

test('installed BGE + PostgreSQL RAG answers current product questions with actual semantic vectors',{skip:process.env.TEST_RAG_LIVE!=='1',timeout:120000},async()=>{
 const f=await iterationFixture({schemas:['schema.sql','agent/schema.sql']});
 let calls=0;const embed=async texts=>{calls++;return embedNames(texts);};
 const report={at:new Date().toISOString(),scope:'local isolated PostgreSQL + actual BGE CPU encoder; no production writes',queries:[]};
 try{
  const rag=createKnowledge({query:f.query,embed,enabled:()=>false});
  for(const [query,id] of [
   ['我经常收藏博物馆，会改变下一次旅行问卷吗？','personalization'],
   ['想知道保存的帖子是谁写的，什么时候收藏的','personal-library'],
   ['刷到发现列表底部，能继续看新内容吗？','discovery'],
   ['景点简介是模型自己编的吗？','place-descriptions'],
   ['路线上的弯曲连线就是实际步行道路吗？','routes'],
   ['不想赶路，怎样让助手以后都记住？','style'],
  ]){
   const start=performance.now(),found=await rag.search(query),answer=await rag.answer(query);
   report.queries.push({query,mode:found.mode,documents:found.documents.map(d=>({id:d.id,lexical:d.lexical,semantic:d.semantic})),answerSources:answer.sources.map(s=>s.id),ms:Math.round(performance.now()-start)});
   assert.equal(found.mode,'hybrid_bge');assert.equal(found.documents[0]?.id,id,query);
   assert.equal(answer.sources[0]?.id,id,'the answer must use the relevant document, not merely retrieve it somewhere');
   assert.ok(answer.sources.length);assert.ok(answer.sources.every(s=>knowledge.some(k=>k.id===s.id)));
  }
  const stored=(await f.query('SELECT count(*)::int n FROM agent_knowledge WHERE cardinality(embedding)=512')).rows[0].n;
  assert.equal(stored,knowledge.length);
  const before=calls;const reused=createKnowledge({query:f.query,embed,enabled:()=>false});await reused.search('如何修改保存的行程');assert.equal(calls-before,1,'new knowledge instance must reuse stored document vectors');
  const start=performance.now();const answers=await Promise.all(Array.from({length:12},(_,i)=>rag.answer(i%2?'怎样取消收藏':'如何修改自己的行程')));
  assert.ok(answers.every(a=>a.retrieval==='hybrid_bge'&&a.sources.length));report.pressure={concurrency:12,elapsedMs:Math.round(performance.now()-start)};
  report.peakRssMiB=Math.round(process.resourceUsage().maxRSS/1024);report.heapUsedMiB=Math.round(process.memoryUsage().heapUsed/1048576);report.storedVectors=stored;
 }finally{
  await mkdir('validation/personalization',{recursive:true});await writeFile('validation/personalization/rag-live.json',JSON.stringify(report,null,2));
  await disposeEmbedding();await f.close();
 }
});
