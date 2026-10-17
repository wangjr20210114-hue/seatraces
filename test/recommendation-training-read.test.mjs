import test from 'node:test';
import assert from 'node:assert/strict';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {trainingSamples} from '../server/recommendation/training.mjs';
import {profileVector,validVector} from '../server/recommendation/features.mjs';
import {trainTower,artifactDigest} from '../server/recommendation/model.mjs';

test('REC-M01 raw 20,000 row cap applies before invalid-vector filtering; cursor retains microseconds',async()=>{
 const asOf='2026-10-17 08:00:00.123456+00',cursor='2026-09-01 00:00:00.123987+00';let pages=0;
 const result=await trainingSamples(async(sql,args)=>{
  if(sql.startsWith('SELECT now()'))return {rows:[{as_of:asOf}]};
  assert.equal(args[0],false);assert.equal(args[3],asOf);assert.equal(args[4],500);
  assert.equal(args[1],pages?cursor:null);assert.equal(args[2],pages?String(pages*500-1):null);
  const start=pages++*500;return {rows:Array.from({length:500},(_,i)=>({cursor_at:cursor,cursor_id:String(start+i),user_vector:[],item_vector:[]}))};
 },'real');assert.deepEqual(result,[]);assert.equal(pages,40);
});

test('REC-M02 empty data finishes; a page error rejects the batch rather than training a partial dataset',async()=>{
 let calls=0;assert.deepEqual(await trainingSamples(async()=>({rows:++calls===1?[{as_of:'2026-10-17'}]:[]}), 'synthetic'),[]);assert.equal(calls,2);
 let page=0;await assert.rejects(trainingSamples(async(sql)=>{
  if(sql.startsWith('SELECT now()'))return {rows:[{as_of:'2026-10-17'}]};
  if(page++)throw Error('simulated interrupted page');
  return {rows:Array.from({length:500},()=>({cursor_at:'2026-09-01',cursor_id:'a',user_vector:[]}))};
 },'real'),/interrupted page/);
});

// Independent reference for the pre-fix single-query behavior. Only this small
// disposable fixture may read complete traces; production code never uses it.
async function legacySamples(query,scope){
 const rows=(await query(`SELECT e.user_id,e.post_id,e.created_at,e.item_vector,r.user_vector,u.synthetic_batch_id,r.trace->'items' trace_items,
  (SELECT jsonb_agg(jsonb_build_object('kind',s.kind,'active',s.active)) FROM (
   SELECT DISTINCT ON(o.kind) o.kind,o.active FROM recommendation_outcomes o WHERE o.user_id=e.user_id
    AND (o.post_id=e.post_id OR (o.kind='follow' AND o.author_id=p.user_id))
    AND o.occurred_at>=e.created_at AND o.occurred_at<e.created_at+interval '7 days'
   ORDER BY o.kind,o.occurred_at DESC,o.id DESC) s) outcomes
 FROM recommendation_exposures e JOIN recommendation_requests r ON r.id=e.request_id JOIN users u ON u.id=e.user_id
 JOIN posts p ON p.id=e.post_id LEFT JOIN recommendation_items i ON i.post_id=p.id
 WHERE u.is_synthetic=$1 AND p.is_synthetic=$1 AND e.visible_ms>=1000 AND e.created_at<now()-interval '7 days'
 AND p.user_id<>e.user_id AND p.hidden_at IS NULL AND NOT p.auto_shared ORDER BY e.created_at DESC,e.id LIMIT 20000`,[scope==='synthetic'])).rows;
 const seen=new Set();return rows.filter(r=>validVector(r.user_vector)&&validVector(r.item_vector)&&r.trace_items?.some(p=>p.id===r.post_id&&p.parts)).map(r=>{
  const active=new Set((r.outcomes||[]).filter(s=>s.active).map(s=>s.kind));
  const value=active.has('not_interested')||active.has('dissatisfied')?-4:active.has('satisfied')?5:active.has('adopt')?4:active.has('save')?3:active.has('recommend')?2:active.has('like')?1:active.has('follow')?.6:active.has('comment')?.5:0;
  return {userId:r.user_id,postId:r.post_id,syntheticBatchId:r.synthetic_batch_id,at:new Date(r.created_at).getTime(),user:r.user_vector,item:r.item_vector,label:value>0?1:0,weight:value?Math.abs(value):.2,parts:r.trace_items.find(p=>p.id===r.post_id).parts};
 }).sort((a,b)=>a.at-b.at).filter(s=>{const key=s.userId+':'+s.postId;if(seen.has(key))return false;seen.add(key);return true;});
}

test('REC-M03 paginated SQL matches legacy samples and model weights across tied and microsecond timestamps',{skip:process.env.TEST_RECOMMENDATION!=='1',timeout:120000},async()=>{
 const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','agent/schema.sql','social/schema.sql','social/style-schema.sql','recommendation/schema.sql']});
 try{
  await f.query("INSERT INTO users(id,username,password_hash,nickname) SELECT gen_random_uuid(),'read_case_'||n,'!disabled','隔离分页'||n FROM generate_series(1,24) n");
  await f.query("INSERT INTO posts(id,user_id,title,body,tags,snapshot) SELECT gen_random_uuid(),$1,'隔离帖子'||n,'测试','{}','{}' FROM generate_series(1,50) n",[f.users.other.id]);
  const ids=(await f.query('SELECT id FROM posts ORDER BY id')).rows.map(r=>r.id),vector=profileVector({}, {interests:['人文']});
  const trace={items:ids.map((id,i)=>({id,parts:i===0?null:{coarse:.4,affinity:i/50,author:0,city:0,quality:.4,fresh:.3,seen:0,tower:0},unused:'omitted detail '.repeat(100)}))};
  await f.query("INSERT INTO recommendation_requests(id,user_id,profile_version,user_vector,context,candidate_ids,trace,algorithm) SELECT gen_random_uuid(),id,0,$1,'{}',$2,$3,'pagination-test' FROM users WHERE username LIKE 'read_case_%'",[vector,ids,trace]);
  // Some timestamps are identical; the remainder differ by microseconds but
  // all become the same millisecond in JS. Both cases cross 500-row boundaries.
  await f.query(`INSERT INTO social_impressions(id,user_id,post_id,context,visible_ms,created_at)
   SELECT gen_random_uuid(),u.id,p.id,'feed',5000,date_trunc('milliseconds',now()-interval '20 days')+floor((row_number() OVER(ORDER BY u.id,p.id)-1)/3)*interval '1 microsecond'
   FROM users u CROSS JOIN posts p WHERE u.username LIKE 'read_case_%'`);
  await f.query(`INSERT INTO recommendation_exposures(id,request_id,user_id,post_id,position,item_vector,visible_ms,created_at)
   SELECT s.id,r.id,s.user_id,s.post_id,0,$1,s.visible_ms,s.created_at FROM social_impressions s JOIN recommendation_requests r ON r.user_id=s.user_id`,[vector]);
  await f.query("INSERT INTO social_impressions(id,user_id,post_id,context,visible_ms,created_at) SELECT gen_random_uuid(),user_id,post_id,'feed',5000,created_at-interval '1 day' FROM recommendation_exposures ORDER BY id LIMIT 60");
  await f.query(`INSERT INTO recommendation_exposures(id,request_id,user_id,post_id,position,item_vector,visible_ms,created_at)
   SELECT s.id,r.id,s.user_id,s.post_id,0,$1,s.visible_ms,s.created_at FROM social_impressions s JOIN recommendation_requests r ON r.user_id=s.user_id WHERE NOT EXISTS(SELECT 1 FROM recommendation_exposures e WHERE e.id=s.id)`,[vector]);
  await f.query('UPDATE posts SET hidden_at=now() WHERE id=$1',[ids[1]]);
  await f.query('UPDATE posts SET auto_shared=true WHERE id=$1',[ids[2]]);
  await f.query('UPDATE posts SET is_synthetic=true WHERE id=$1',[ids[3]]);
  await f.query("UPDATE recommendation_exposures SET visible_ms=999 WHERE id IN(SELECT id FROM recommendation_exposures ORDER BY id LIMIT 8)");
  await f.query('UPDATE recommendation_exposures SET item_vector=$1 WHERE id IN(SELECT id FROM recommendation_exposures ORDER BY id DESC LIMIT 8)',[Array(96).fill(101)]);
  await f.query(`INSERT INTO recommendation_outcomes(user_id,post_id,kind,active,occurred_at)
   SELECT user_id,post_id,CASE WHEN n%3=0 THEN 'not_interested' ELSE 'save' END,true,created_at+interval '1 hour'
   FROM (SELECT e.*,row_number() OVER(ORDER BY id) n FROM recommendation_exposures e) x WHERE n%2=0`);
  const before=(await f.query('SELECT count(*)::int n FROM recommendation_exposures')).rows[0].n;
  const reference=await legacySamples(f.query,'real');let pages=0,total=0;
  const actual=await trainingSamples(async(sql,args)=>{const r=await f.query(sql,args);if(sql.startsWith('WITH page AS MATERIALIZED')){pages++;total+=r.rows.length;assert.ok(r.rows.length<=500);assert.ok(r.rows.every(x=>!('trace_items' in x)&&!('features' in x)&&!('cities' in x)));}return r;},'real');
  assert.ok(pages>=3);assert.ok(total>1000);assert.deepEqual(actual,reference);
  assert.equal(artifactDigest(trainTower(actual,{epochs:1}).model),artifactDigest(trainTower(reference,{epochs:1}).model));
  assert.deepEqual(await trainingSamples(f.query,'synthetic'),await legacySamples(f.query,'synthetic'));
  assert.equal((await f.query('SELECT count(*)::int n FROM recommendation_exposures')).rows[0].n,before);
 }finally{await f.close();}
});
