import {randomUUID} from 'node:crypto';
import {cosine,clamp,validVector} from './features.mjs';
import {trainTower,trainRanker,towerScore,rankScore,rankInputs,rankingMetrics,encode,artifactDigest} from './model.mjs';
import {ruleFineScore} from './engine.mjs';
const groups=rows=>Object.values(Object.groupBy(rows,r=>r.userId));
export async function trainingSamples(query,scope){
 // Freeze maturity at the database clock; keyset cursors retain PostgreSQL's
 // microseconds (a JavaScript Date would skip rows at a page boundary).
 const asOf=(await query('SELECT now()::text AS as_of')).rows[0].as_of;
 const samples=[];let cursorAt=null,cursorId=null,read=0;
 while(read<20000){
  const limit=Math.min(500,20000-read);
  const rows=(await query(`WITH page AS MATERIALIZED (
   SELECT e.*,u.synthetic_batch_id,p.user_id author_id FROM recommendation_exposures e
   JOIN recommendation_requests r ON r.id=e.request_id JOIN users u ON u.id=e.user_id JOIN posts p ON p.id=e.post_id
   WHERE u.is_synthetic=$1 AND p.is_synthetic=$1 AND e.visible_ms>=1000 AND e.created_at<$4::timestamptz-interval '7 days'
    AND p.user_id<>e.user_id AND p.hidden_at IS NULL AND NOT p.auto_shared
    AND ($2::timestamptz IS NULL OR e.created_at<$2::timestamptz OR (e.created_at=$2::timestamptz AND e.id>$3::uuid))
   ORDER BY e.created_at DESC,e.id LIMIT $5
  ) SELECT e.user_id,e.post_id,e.created_at,e.created_at::text cursor_at,e.id cursor_id,e.item_vector,r.user_vector,e.synthetic_batch_id,
  (SELECT item->'parts' FROM jsonb_array_elements(r.trace->'items') item WHERE item->>'id'=e.post_id::text LIMIT 1) parts,
  (SELECT jsonb_agg(jsonb_build_object('kind',s.kind,'active',s.active)) FROM (
   SELECT DISTINCT ON(o.kind) o.kind,o.active FROM recommendation_outcomes o WHERE o.user_id=e.user_id
    AND (o.post_id=e.post_id OR (o.kind='follow' AND o.author_id=e.author_id))
    AND o.occurred_at>=e.created_at AND o.occurred_at<e.created_at+interval '7 days'
   ORDER BY o.kind,o.occurred_at DESC,o.id DESC) s) outcomes
 FROM page e JOIN recommendation_requests r ON r.id=e.request_id
 ORDER BY e.created_at DESC,e.id`,[scope==='synthetic',cursorAt,cursorId,asOf,limit])).rows;
  for(const r of rows){
  if(!validVector(r.user_vector)||!validVector(r.item_vector)||!r.parts)continue;
  const signals=new Set((r.outcomes||[]).filter(x=>x.active).map(x=>x.kind)),negative=signals.has('not_interested');
  const value=negative||signals.has('dissatisfied')?-4:signals.has('satisfied')?5:signals.has('adopt')?4:signals.has('save')?3:signals.has('recommend')?2:signals.has('like')?1:signals.has('follow')?.6:signals.has('comment')?.5:0;
  samples.push({userId:r.user_id,postId:r.post_id,syntheticBatchId:r.synthetic_batch_id,at:new Date(r.created_at).getTime(),user:r.user_vector,item:r.item_vector,label:value>0?1:0,weight:value?Math.abs(value):.2,parts:r.parts});
  }
  read+=rows.length;if(rows.length<limit)break;
  cursorAt=rows.at(-1).cursor_at;cursorId=rows.at(-1).cursor_id;
 }
 const seen=new Set();
 return samples.sort((a,b)=>a.at-b.at).filter(s=>{
  // Keep raw browsing events for audit, but let one user/post pair vote only
  // once in this bounded training dataset, including across time partitions.
  // Choose its first valid exposure and that exposure's label window.
  const key=s.userId+':'+s.postId;if(seen.has(key))return false;seen.add(key);return true;
 });
}
export async function trainRecommendations({query,transaction,scope='synthetic',activate=false,epochs=18}){
 if(!['synthetic','real'].includes(scope))throw Error('Unknown model scope');
 const started=performance.now(),samples=await trainingSamples(query,scope);
 if(samples.length<300) return {status:'insufficient_data',scope,samples:samples.length,required:300,activeChanged:false};
 // Time boundaries, not random splitting. Leave a full label window between
 // train/validation/test so future outcomes cannot label earlier partitions.
 const a=samples[Math.floor(samples.length*.60)].at,b=samples[Math.floor(samples.length*.80)].at,week=7*86400000;
 const train=samples.filter(s=>s.at+week<a),validation=samples.filter(s=>s.at>=a&&s.at+week<b),test=samples.filter(s=>s.at>=b);
 if(train.length<150||validation.length<50||test.length<50||new Set(train.map(s=>s.userId)).size<10||new Set(train.map(s=>s.postId)).size<30)
  return {status:'insufficient_temporal_coverage',scope,counts:{train:train.length,validation:validation.length,test:test.length},activeChanged:false};
 const trained=trainTower(train,{epochs});
 const evaluate=(rows,fn)=>rankingMetrics(groups(rows),fn,10);
 const baseline=s=>cosine(s.user,s.item),predict=s=>towerScore(trained.model,s.user,s.item);
 const towerMetrics={trainLoss:trained.loss,validation:evaluate(validation,predict),test:evaluate(test,predict),baselineValidation:evaluate(validation,baseline),baselineTest:evaluate(test,baseline)};
 const rankSamples=rows=>rows.map(s=>({...s,features:rankInputs({...s.parts,tower:predict(s)})}));
 const ranker=trainRanker(rankSamples(train));
 const rankPredict=s=>rankScore(ranker,rankInputs({...s.parts,tower:predict(s)}));
 // Compare the learned fine ranker with the exact rule it replaces, using the
 // same tower. Coarse retrieval has different weights and is not this baseline.
 const rule=s=>ruleFineScore({...s.parts,tower:predict(s)});
 const rankerMetrics={validation:evaluate(validation,rankPredict),test:evaluate(test,rankPredict),baselineValidation:evaluate(validation,rule),baselineTest:evaluate(test,rule)};
 const common={scope,syntheticData:scope==='synthetic',evaluation:'chronological held-out exposed-candidate pools; 7-day embargo; not real-user quality evidence when synthetic',
  syntheticBatchIds:[...new Set(samples.map(s=>s.syntheticBatchId).filter(Boolean))],
  counts:{total:samples.length,train:train.length,validation:validation.length,test:test.length},cutoff:new Date(a).toISOString(),testStarts:new Date(b).toISOString(),
  trainingMs:Math.round(performance.now()-started),processPeakRssMiB:Math.round(process.resourceUsage().maxRSS/1024),rssMiB:Math.round(process.memoryUsage().rss/1048576),heapUsedMiB:Math.round(process.memoryUsage().heapUsed/1048576)};
 const output=[];
 const towerId=randomUUID();ranker.towerId=towerId;
 const passes=m=>m.validation.groups>=5&&m.test.groups>=5&&m.validation.ndcgAtK>m.baselineValidation.ndcgAtK+.005&&m.test.ndcgAtK>m.baselineTest.ndcgAtK+.005;
 for(const [kind,artifact,metrics] of [['two_tower',trained.model,towerMetrics],['ranker',ranker,rankerMetrics]]){
  // Both validation and untouched test must beat the corresponding baseline.
  const eligible=passes(metrics)&&(kind==='two_tower'||passes(towerMetrics));
  const id=kind==='two_tower'?towerId:randomUUID(),state=eligible?(activate?'active':'evaluated'):'rejected';
  await transaction(async c=>{
   if(state==='active')await c.query("UPDATE recommendation_models SET state='evaluated' WHERE kind=$1 AND scope=$2 AND state='active'",[kind,scope]);
   await c.query('INSERT INTO recommendation_models(id,kind,scope,state,artifact,digest,metrics,cutoff) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,kind,scope,state,artifact,artifactDigest(artifact),{...common,...metrics,eligible},new Date(a)]);
   if(kind==='two_tower'){
    let last='00000000-0000-0000-0000-000000000000';for(;;){const items=(await c.query('SELECT post_id,revision,vector FROM recommendation_items WHERE post_id>$1 ORDER BY post_id LIMIT 100',[last])).rows;if(!items.length)break;
     await c.query(`INSERT INTO recommendation_embeddings(model_id,post_id,revision,vector) SELECT $1,x.post_id,x.revision,x.vector FROM jsonb_to_recordset($2::jsonb) AS x(post_id uuid,revision integer,vector real[])`,[id,JSON.stringify(items.map(p=>({post_id:p.post_id,revision:p.revision,vector:encode(artifact,'item',p.vector)})))]);last=items.at(-1).post_id;
    }
   }
  });output.push({id,kind,state,metrics:{...common,...metrics,eligible}});
 }
 return {status:'evaluated',scope,models:output,elapsedMs:Math.round(performance.now()-started),activeChanged:output.some(m=>m.state==='active')};
}
