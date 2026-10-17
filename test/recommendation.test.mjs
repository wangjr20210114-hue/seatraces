import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {generateDemo,seedDemo,removeDemo} from '../server/recommendation/demo.mjs';
import {contentFeatures,profileVector,cosine,validVector,dimensionKeys} from '../server/recommendation/features.mjs';
import {trainTower,towerScore,validateTower,artifactDigest,rankingMetrics,sigmoid} from '../server/recommendation/model.mjs';
import {trainRecommendations,trainingSamples} from '../server/recommendation/training.mjs';
import {recommend,rerank} from '../server/recommendation/engine.mjs';
import {refreshItem,buildProfile,readProfile} from '../server/recommendation/profiles.mjs';
import {recordExposure,updateExposure,recordInspiration,confirmAdoption} from '../server/recommendation/events.mjs';
import {installSocialCommunity} from '../server/social/community.mjs';
import {installCommunityInteractions} from '../server/services/community-interactions.mjs';
import {installRecommendationRoutes} from '../server/recommendation/routes.mjs';

test('demo corpus is deterministic, varied, historical and bounded',async()=>{
 const now=Date.now(),a=await generateDemo({now}),b=await generateDemo({now});assert.deepEqual(a,b);
 assert.equal(a.users.length,50);assert.equal(new Set(a.users.map(u=>u.nickname)).size,50);assert.equal(a.posts.length,500);
 assert.ok(a.users.every(u=>!/^test|^demo/.test(u.username)));assert.equal(new Set(a.posts.map(p=>p.body)).size,500);
 assert.ok(new Set(a.posts.map(p=>p.createdAt.slice(0,10))).size>120);assert.ok(new Set(a.posts.map(p=>p.style)).size>=10);
 assert.ok(a.posts.every(p=>Date.parse(p.createdAt)<now&&Date.parse(p.createdAt)>Date.parse(a.users.find(u=>u.id===p.userId).createdAt)));
 assert.ok(a.posts.every(p=>p.body.length<=4000&&p.title.length<=100));
});
test('two independent trainable towers learn without GPU; explicit preferences prevail',()=>{
 const a=profileVector({}, {interests:['人文']}),b=profileVector({}, {interests:['自然']});
 const samples=Array.from({length:100},(_,i)=>({user:i%2?a:b,item:i%4<2?a:b,label:(i%2?1:0)===(i%4<2?1:0)?1:0,weight:1}));
 const r=trainTower(samples,{epochs:20});assert.ok(validateTower(r.model));assert.ok(r.loss.at(-1)<r.loss[0]);
 assert.ok(towerScore(r.model,a,a)>towerScore(r.model,a,b));assert.notDeepEqual(r.model.user,r.model.item);
 assert.ok(validVector(a));const v=profileVector({content:{'interest.museum':{long:{value:-1,confidence:1}}}}, {interests:['人文']});assert.equal(v[dimensionKeys.indexOf('interest.museum')],1);
 assert.equal(artifactDigest({b:1,a:2}),artifactDigest({a:2,b:1}));
 assert.throws(()=>trainTower([{user:a,item:[NaN],label:1}]),/sample count/);
});
test('rerank suppresses duplicate routes and avoids three same authors when possible',()=>{
 const rows=Array.from({length:18},(_,i)=>({id:String(i),user_id:i<12?'a':'b',route_key:i<2?'same':String(i),fine:1-i/100,parts:{fresh:.5,quality:.5}}));
 const r=rerank(rows);assert.equal(r.filter(p=>p.route_key==='same').length,1);assert.ok(r.slice(0,8).some(p=>p.rerankReason==='fresh_exploration'));assert.equal(r[2].user_id,'b');
});

test('recommendation database, CPU training, ownership, pressure and reversible simulation',{skip:process.env.TEST_RECOMMENDATION!=='1',timeout:240000},async t=>{
 const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','agent/schema.sql','social/schema.sql','social/style-schema.sql','recommendation/schema.sql']});
 const report={startedAt:new Date().toISOString(),environment:'isolated PostgreSQL schema; synthetic data only',node:process.version};
 try{
  installSocialCommunity(f.app,{...f,recommend:(user,o)=>recommend(f.query,user,o),onImpression:recordExposure,onVisible:updateExposure});
  installCommunityInteractions(f.app,f);installRecommendationRoutes(f.app,f);await f.start();
  const started=performance.now(),batch=await seedDemo(f);report.seedMs=Math.round(performance.now()-started);report.batch=batch.batchId;
  const count=await f.query('SELECT count(*)::int n FROM posts WHERE is_synthetic');assert.equal(count.rows[0].n,500);
  assert.equal((await seedDemo(f)).status,'already_exists');
  const users=(await f.query('SELECT * FROM users WHERE is_synthetic ORDER BY username')).rows;
  const post=(await f.query('SELECT * FROM posts WHERE is_synthetic ORDER BY id LIMIT 1')).rows[0],uid=f.users.user.id;
  await t.test('synthetic account cannot authenticate and has no admin access',async()=>{
   const r=await f.request('/api/auth/login',{user:null,body:{username:users[0].username,password:'whatever-12345'}});assert.equal(r.status,401);
   assert.ok(users.every(u=>u.role==='user'&&u.analytics_excluded&&u.password_hash.startsWith('!synthetic:')));
  });
  await t.test('multi-channel recall searches older items beyond recent 120 and respects hiding',async()=>{
   await f.query("UPDATE users SET preferences='{}' WHERE id=$1",[uid]);
   const target=randomUUID();await f.query("INSERT INTO posts(id,user_id,title,body,tags,snapshot,created_at) VALUES($1,$2,'素食散步路线','沿途的素食餐厅和素菜选择',$3,'{}',now()-interval '300 days')",[target,f.users.other.id,[]]);await refreshItem({query:f.query},target);
   const u={id:uid,preferences:{interests:[]}};const v=profileVector({},u.preferences);v[dimensionKeys.indexOf('food.vegetarian')]=1;
   await f.query(`INSERT INTO recommendation_profiles(user_id,travel,content,authors,vector,evidence,algorithm) VALUES($1,$2,'{}','{}',$3,'[]','test')`,[uid,{'food.vegetarian':{long:{value:1,confidence:1}}},v]);
   const latest=(await f.query('SELECT id FROM posts ORDER BY created_at DESC LIMIT 120')).rows;assert.ok(!latest.some(p=>p.id===target));
   const r=await recommend(f.query,u);assert.ok(r.rows.some(p=>p.id===target));assert.ok(r.trace.channels.interest>0);assert.ok(r.rows.length<=120);assert.equal(r.trace.models.tower,null);
   await f.query('UPDATE posts SET hidden_at=now() WHERE id=$1',[target]);assert.ok(!(await recommend(f.query,u)).rows.some(p=>p.id===target));
  });
  await t.test('feed keeps old interface, marks fiction, freezes pagination and verifies impressions',async()=>{
   const first=await f.request('/api/social/feed',{user:'user'});assert.equal(first.status,200);assert.ok(first.data.requestId);assert.ok(first.data.items.some(p=>p.is_synthetic));
   const id=first.data.items[0].id,imp=randomUUID();
   assert.equal((await f.request('/api/social/posts/'+id+'/impressions',{user:'other',body:{id:imp,context:'feed',requestId:first.data.requestId}})).status,404);
   assert.equal((await f.request('/api/social/posts/'+id+'/impressions',{user:'user',body:{id:imp,context:'feed',requestId:first.data.requestId}})).status,200);
   assert.equal((await f.query('SELECT count(*)::int n FROM recommendation_exposures WHERE id=$1',[imp])).rows[0].n,1);
   assert.equal((await f.request('/api/social/impressions/'+imp,{user:'other',method:'PUT',body:{visibleMs:5000}})).status,404);
   await f.query("UPDATE social_impressions SET created_at=now()-interval '10 seconds' WHERE id=$1",[imp]);
   await f.request('/api/social/impressions/'+imp,{user:'user',method:'PUT',body:{visibleMs:5000}});
   assert.equal((await f.query('SELECT visible_ms FROM recommendation_exposures WHERE id=$1',[imp])).rows[0].visible_ms,5000);
   if(first.data.nextCursor){const second=await f.request('/api/social/feed?cursor='+encodeURIComponent(first.data.nextCursor),{user:'user'});assert.equal(second.status,200);assert.ok(second.data.items.every(p=>!first.data.items.some(a=>a.id===p.id)));}
   assert.equal((await f.request('/api/admin/recommendation/users/'+uid+'/preview',{user:'user'})).status,403);
  });
  await t.test('comment and follow are separated from travel preferences; save cancellation reverses',async()=>{
   await f.query('DELETE FROM browse_events WHERE user_id=$1',[uid]);
   await f.query('INSERT INTO comments(id,user_id,post_id,body) VALUES($1,$2,$3,$4)',[randomUUID(),uid,post.id,'不喜欢这里，太挤了']);
   await f.query('INSERT INTO user_follows(user_id,author_id) VALUES($1,$2)',[uid,post.user_id]);await f.transaction(c=>buildProfile(c,uid));
   let p=await readProfile(f.query,{id:uid});assert.equal(Object.keys(p.travel).length,0);assert.ok(Object.keys(p.content).length);assert.equal(Object.keys(p.authors).length,1);
   await f.query("INSERT INTO reactions(user_id,post_id,kind) VALUES($1,$2,'save')",[uid,post.id]);await f.transaction(c=>buildProfile(c,uid));assert.ok(Object.keys((await readProfile(f.query,{id:uid})).travel).length);
   await f.query("DELETE FROM reactions WHERE user_id=$1 AND post_id=$2",[uid,post.id]);await f.transaction(c=>buildProfile(c,uid));assert.equal(Object.keys((await readProfile(f.query,{id:uid})).travel).length,0);
  });
  await t.test('actual route adoption and private satisfaction require owner and saved matching trip',async()=>{
   const p=(await f.query("SELECT * FROM posts WHERE is_synthetic AND snapshot ? 'days' LIMIT 1")).rows[0],sid=randomUUID(),tid=randomUUID();
   await f.query('INSERT INTO journey_sessions(id,user_id,request) VALUES($1,$2,$3)',[sid,uid,{}]);
   await assert.rejects(f.transaction(c=>recordInspiration(c,{sessionId:sid,userId:uid,postId:p.id})),/先选择/);
   await f.query('INSERT INTO social_adoptions(user_id,post_id) VALUES($1,$2)',[uid,p.id]);await f.transaction(c=>recordInspiration(c,{sessionId:sid,userId:uid,postId:p.id}));
   await f.query('INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,$3,$4,$5)',[tid,uid,'保存的行程',{},p.snapshot]);
   await f.transaction(c=>confirmAdoption(c,{sessionId:sid,userId:uid,tripId:tid,plan:{days:[]}}));assert.equal((await f.query('SELECT trip_id FROM recommendation_trip_sources WHERE session_id=$1',[sid])).rows[0].trip_id,null);
   await f.transaction(c=>confirmAdoption(c,{sessionId:sid,userId:uid,tripId:tid,plan:p.snapshot}));assert.equal((await f.query('SELECT trip_id FROM recommendation_trip_sources WHERE session_id=$1',[sid])).rows[0].trip_id,tid);
   const url='/api/journey/trips/'+tid+'/feedback';assert.equal((await f.request(url,{user:'other'})).status,404);
   assert.equal((await f.request(url,{user:'user',method:'PUT',body:{rating:6}})).status,400);
   assert.equal((await f.request(url,{user:'user',method:'PUT',body:{rating:5,experience:'trip'}})).status,400);
   assert.equal((await f.request(url,{user:'user',method:'PUT',body:{rating:5,experience:'plan',aspects:{places:5}}})).status,200);
   await f.query("UPDATE trips SET status='completed' WHERE id=$1",[tid]);assert.equal((await f.request(url,{user:'user',method:'PUT',body:{rating:5,experience:'trip'}})).status,200);
   assert.ok((await f.query("SELECT 1 FROM recommendation_outcomes WHERE user_id=$1 AND post_id=$2 AND kind='satisfied' AND active",[uid,p.id])).rowCount);
   assert.equal((await f.request(url,{user:'user',method:'DELETE'})).status,200);assert.equal((await f.request(url,{user:'user'})).data.feedback,null);
  });
  await t.test('CPU training uses chronological embargo, guarded activation and tamper fallback',async()=>{
   const samples=await trainingSamples(f.query,'synthetic');assert.ok(samples.length>3000);assert.ok(samples.some(s=>s.weight===5));
   const r=await trainRecommendations({...f,activate:true});assert.equal(r.status,'evaluated');assert.equal(r.models.length,2);report.training=r;
   assert.ok(r.models.every(m=>m.metrics.counts.train>=150&&m.metrics.syntheticData));
   const storedTower=(await f.query('SELECT artifact FROM recommendation_models WHERE id=$1',[r.models[0].id])).rows[0].artifact;
   const testSamples=samples.filter(s=>s.at>=Date.parse(r.models[1].metrics.testStarts));
   const servingBaseline=s=>{const p=s.parts;return sigmoid(p.affinity*3+p.author*.25+p.city*.7+p.quality*.45+p.fresh*.2-p.seen*.8+towerScore(storedTower,s.user,s.item));};
   assert.deepEqual(r.models[1].metrics.baselineTest,rankingMetrics(Object.values(Object.groupBy(testSamples,s=>s.userId)),servingBaseline,10),'fine-ranker evaluation must compare the exact serving fallback, not coarse ranking');
   const real=await recommend(f.query,{id:uid,preferences:{}});assert.equal(real.trace.models.tower,null);assert.equal(real.trace.models.ranker,null);
   // Exercise the serving path even when evaluation rightly rejects the model.
   // This forced activation exists only in the disposable test schema.
   const active=r.models.find(m=>m.kind==='two_tower');await f.query("UPDATE recommendation_models SET state='active' WHERE id=$1",[active.id]);
   const learned=await recommend(f.query,users[0],{allowSyntheticModel:true});assert.equal(learned.trace.models.tower,active.id);assert.ok(learned.trace.channels.two_tower>0);
   assert.equal((await recommend(f.query,users[0])).trace.models.tower,null);
   await f.query("UPDATE recommendation_models SET digest='tampered' WHERE id=$1",[active.id]);assert.equal((await recommend(f.query,users[0],{allowSyntheticModel:true})).trace.models.tower,null);
   assert.equal((await trainRecommendations({...f,scope:'real'})).status,'insufficient_data');
  });
  await t.test('64 concurrent requests remain bounded and return distinct eligible candidates',async()=>{
   const timings=[],started=performance.now();let errors=0;const memoryBefore=process.memoryUsage();
   for(let batch=0;batch<8;batch++)await Promise.all(Array.from({length:8},async(_,i)=>{const start=performance.now();try{const r=await recommend(f.query,users[(batch*8+i)%50],{persist:false});assert.ok(r.rows.length<=120);assert.equal(new Set(r.rows.map(p=>p.id)).size,r.rows.length);assert.ok(r.trace.counts.recall<=700);}catch(e){errors++;throw e;}finally{timings.push(performance.now()-start);}}));
   timings.sort((a,b)=>a-b);report.pressure={requests:64,concurrency:8,errors,elapsedMs:Math.round(performance.now()-started),p50Ms:Math.round(timings[31]),p95Ms:Math.round(timings[60]),maxMs:Math.round(timings.at(-1)),rssBeforeMiB:Math.round(memoryBefore.rss/1048576),rssAfterMiB:Math.round(process.memoryUsage().rss/1048576),processPeakRssMiB:Math.round(process.resourceUsage().maxRSS/1024),note:'Single process includes fixture, trainer and request tasks; not isolated production server capacity'};
   assert.equal(errors,0);
  });
  await t.test('cleanup removes only this fictional batch and its relations',async()=>{
   const before=(await f.query('SELECT count(*)::int n FROM users WHERE NOT is_synthetic')).rows[0].n;
   const r=await removeDemo({...f,batchId:batch.batchId});assert.equal(r.users,50);assert.equal((await f.query('SELECT count(*)::int n FROM posts WHERE is_synthetic')).rows[0].n,0);
   assert.equal((await f.query('SELECT count(*)::int n FROM users WHERE NOT is_synthetic')).rows[0].n,before);assert.equal((await removeDemo({...f,batchId:batch.batchId})).status,'already_removed');
   assert.equal((await f.query("SELECT count(*)::int n FROM recommendation_models WHERE scope='synthetic'")).rows[0].n,0);
  });
  report.completedAt=new Date().toISOString();await mkdir('reports/recommendation',{recursive:true});await writeFile('reports/recommendation/isolated-results.json',JSON.stringify(report,null,2));
 }finally{await f.close();}
});
