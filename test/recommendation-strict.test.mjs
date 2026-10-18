import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {recommend,rerank} from '../server/recommendation/engine.mjs';
import {refreshItem,buildProfile,readProfile,recommendationPreferences} from '../server/recommendation/profiles.mjs';
import {createStyleWorker} from '../server/social/style-store.mjs';
import {scorePlace} from '../server/domain/scenic-clusters.mjs';
import {recordExposure,updateExposure} from '../server/recommendation/events.mjs';
import {trainingSamples} from '../server/recommendation/training.mjs';
import {profileVector} from '../server/recommendation/features.mjs';
import {createTower,artifactDigest,random} from '../server/recommendation/model.mjs';
import {installSocialCommunity} from '../server/social/community.mjs';
import {installCommunityInteractions} from '../server/services/community-interactions.mjs';
import {installRecommendationRoutes} from '../server/recommendation/routes.mjs';

test('REC-S01 randomized reranking preserves uniqueness, route suppression and finite scores',()=>{
 const rnd=random(91);
 for(let round=0;round<100;round++){
  const rows=Array.from({length:Math.floor(rnd()*150)},(_,i)=>({id:String(i),user_id:'a'+Math.floor(rnd()*10),route_key:rnd()<.3?null:'route'+Math.floor(rnd()*40),fine:rnd(),parts:{fresh:rnd(),quality:rnd()},vector:profileVector({})}));
  const result=rerank(rows);assert.ok(result.length<=120);assert.equal(new Set(result.map(r=>r.id)).size,result.length);
  const routes=result.map(r=>r.route_key).filter(Boolean);assert.equal(new Set(routes).size,routes.length);
  assert.ok(result.every(r=>rows.some(p=>p.id===r.id)&&Number.isFinite(r.fine)));
 }
});

test('strict recommendation HTTP and temporal data contracts',{skip:process.env.TEST_RECOMMENDATION!=='1',timeout:120000},async t=>{
 const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','agent/schema.sql','social/schema.sql','social/style-schema.sql','recommendation/schema.sql']});
 try{
  let failRecommendation=false;
  installSocialCommunity(f.app,{...f,recommend:(user,o)=>{if(failRecommendation)throw Error('private-database-diagnostic-marker');return recommend(f.query,user,o);},onImpression:recordExposure,onVisible:updateExposure});
  installCommunityInteractions(f.app,f);installRecommendationRoutes(f.app,f);await f.start();
  const uid=f.users.user.id,author=f.users.other.id;
  async function post(title='园林与博物馆',snapshot={}){const id=randomUUID();await f.query('INSERT INTO posts(id,user_id,title,body,tags,snapshot) VALUES($1,$2,$3,$4,$5,$6)',[id,author,title,'真实隔离验收内容',[],snapshot]);await refreshItem({query:f.query},id);return id;}
  const ids=[];for(let n=0;n<24;n++)ids.push(await post('园林与博物馆 '+n));
  const route='/api/social/posts/'+ids[0];
  await t.test('REC-S22 fresh recommendation batches exclude rendered IDs and validate bounded payloads',async()=>{
   const r=await f.request('/api/social/feed',{user:'user'});const exclude=r.data.items.map(p=>p.id);
   const next=await f.request('/api/social/feed',{user:'user',body:{exclude,limit:12}});assert.equal(next.status,200);assert.ok(next.data.items.length);
   assert.ok(next.data.items.every(p=>!exclude.includes(p.id)));
   const trace=(await f.query('SELECT trace FROM recommendation_requests WHERE id=$1',[next.data.requestId])).rows[0].trace;
   assert.equal(trace.excludedCount,exclude.length);assert.equal(trace.exploration,true);
   assert.equal((await f.request('/api/social/feed',{user:null,body:{exclude:[]}})).status,401);
   for(const body of [{exclude:['invalid']},{exclude:Array(601).fill(ids[0])},{scope:'mine',exclude:[]},{cursor:ids[0]+':1',exclude:[]},{exclude:[],userId:author}])assert.equal((await f.request('/api/social/feed',{user:'user',body})).status,400);
   const replies=await Promise.all(Array.from({length:16},()=>f.request('/api/social/feed',{user:'user',body:{exclude}})));
   assert.ok(replies.every(x=>x.status===200&&x.data.items.every(p=>!exclude.includes(p.id))));
   assert.ok((await f.query('SELECT count(*)::int n FROM social_feed_sessions WHERE user_id=$1',[uid])).rows[0].n<=6);
  });
  await t.test('REC-S02 anonymous/ordinary/application-only admin cookies cannot read management traces',async()=>{
   for(const user of [null,'user'])for(const p of ['/api/admin/recommendation/models','/api/admin/recommendation/users/'+uid+'/preview','/api/admin/recommendation/requests/'+randomUUID()])assert.ok([401,403].includes((await f.request(p,{user})).status));
   assert.equal((await f.request('/api/admin/recommendation/models',{headers:{Cookie:f.users.admin.appCookie}})).status,401);
   const admin=await f.request('/api/admin/recommendation/models');assert.equal(admin.status,200);assert.ok(!JSON.stringify(admin.data).includes('password'));
  });
  await t.test('REC-S03 malformed UUID, extra fields, invalid paging and literal wildcard search',async()=>{
   for(const url of ['/api/social/feed?scope=admin','/api/social/feed?limit=-1','/api/social/feed?limit=31','/api/social/feed?limit=Infinity','/api/social/feed?admin=true','/api/social/feed?cursor=oops','/api/journey/trips/not-uuid/feedback'])assert.equal((await f.request(url,{user:'user'})).status,400,url);
   for(const q of ['%',"' OR 1=1 --",'_',String.fromCharCode(0)]){const r=await f.request('/api/social/feed?q='+encodeURIComponent(q),{user:'user'});assert.ok([200,400].includes(r.status),q+': '+r.status);if(r.status===200)assert.equal(r.data.items.length,0);}
   assert.equal((await f.request(route+'/impressions',{user:'user',body:{id:randomUUID(),context:'feed',userId:author}})).status,400);
  });
  await t.test('REC-S04 frozen pagination rejects another account and reflects hidden/disabled/negative content',async()=>{
   const first=await f.request('/api/social/feed?limit=1',{user:'user'});assert.ok(first.data.nextCursor);
   assert.equal((await f.request('/api/social/feed?cursor='+encodeURIComponent(first.data.nextCursor),{user:'other'})).status,410);
   const rec=(await f.query('SELECT candidate_ids FROM recommendation_requests WHERE id=$1',[first.data.requestId])).rows[0];const hidden=rec.candidate_ids[1];
   await f.query('UPDATE posts SET hidden_at=now() WHERE id=$1',[hidden]);const second=await f.request('/api/social/feed?limit=30&cursor='+encodeURIComponent(first.data.nextCursor),{user:'user'});assert.ok(!second.data.items.some(p=>p.id===hidden));
   await f.query('UPDATE users SET disabled_at=now() WHERE id=$1',[author]);assert.equal((await f.request('/api/social/feed',{user:'user'})).data.items.length,0);
   await f.query('UPDATE users SET disabled_at=NULL WHERE id=$1',[author]);await f.query('UPDATE posts SET hidden_at=NULL WHERE id=$1',[hidden]);
   assert.equal((await f.request(route+'/feedback',{user:'user',method:'PUT',body:{notInterested:true}})).status,200);
   assert.ok(!(await recommend(f.query,{id:uid,preferences:{}})).rows.some(p=>p.id===ids[0]));await f.request(route+'/feedback',{user:'user',method:'PUT',body:{notInterested:false}});
  });
  await t.test('REC-S05 repeated likes are idempotent and cancellation retracts the signal',async()=>{
   const url='/api/posts/'+ids[0]+'/reactions';const responses=await Promise.all(Array.from({length:16},()=>f.request(url,{user:'user',body:{kind:'save',active:true}})));assert.ok(responses.every(r=>r.status===200));
   assert.equal((await f.query("SELECT count(*)::int n FROM recommendation_outcomes WHERE user_id=$1 AND post_id=$2 AND kind='save' AND active",[uid,ids[0]])).rows[0].n,1);
   await f.request(url,{user:'user',body:{kind:'save',active:false}});await f.transaction(c=>buildProfile(c,uid));assert.equal(Object.keys((await readProfile(f.query,{id:uid})).travel).length,0);
  });
  await t.test('REC-S06 deleting one of several comments must not erase remaining comment evidence',async()=>{
   const comments=[randomUUID(),randomUUID()];for(const id of comments)await f.query('INSERT INTO comments(id,user_id,post_id,body) VALUES($1,$2,$3,$4)',[id,uid,ids[0],'仍保留的一条讨论']);
   await f.query('DELETE FROM comments WHERE id=$1',[comments[0]]);
   assert.equal((await f.query("SELECT active FROM recommendation_outcomes WHERE user_id=$1 AND post_id=$2 AND kind='comment' ORDER BY id DESC LIMIT 1",[uid,ids[0]])).rows[0].active,true);
   await f.query('UPDATE comments SET hidden_at=now() WHERE id=$1',[comments[1]]);
   assert.equal((await f.query("SELECT active FROM recommendation_outcomes WHERE user_id=$1 AND post_id=$2 AND kind='comment' ORDER BY id DESC LIMIT 1",[uid,ids[0]])).rows[0].active,false);
  });
  await t.test('REC-S07 repeated raw impressions cannot multiply a recommendation training vote',async()=>{
   const r=await recommend(f.query,{id:uid,preferences:{}}),id=r.rows[0].id;
   const responses=await Promise.all(Array.from({length:8},()=>f.request('/api/social/posts/'+id+'/impressions',{user:'user',body:{id:randomUUID(),context:'feed',requestId:r.requestId}})));
   assert.ok(responses.every(r=>r.status===200));
   // Separate browser appearances may be logged, but may not inflate training.
   await f.query("UPDATE recommendation_exposures SET created_at=now()-interval '10 days',visible_ms=5000 WHERE request_id=$1 AND post_id=$2",[r.requestId,id]);
   assert.equal((await trainingSamples(f.query,'real')).filter(s=>s.postId===id).length,1);
  });
  await t.test('REC-S08 edited item and stale/noncandidate request cannot contaminate exposure snapshots',async()=>{
   const r=await recommend(f.query,{id:uid,preferences:{}}),id=r.rows[0].id;
   await f.query('UPDATE posts SET revision=revision+1,title=$2 WHERE id=$1',[id,'完全修改的帖子']);await refreshItem({query:f.query},id);
   const imp=randomUUID();assert.equal((await f.request('/api/social/posts/'+id+'/impressions',{user:'user',body:{id:imp,context:'feed',requestId:r.requestId}})).status,200);
   assert.equal((await f.query('SELECT 1 FROM recommendation_exposures WHERE id=$1',[imp])).rowCount,0);
   await f.query("UPDATE recommendation_requests SET created_at=now()-interval '2 days' WHERE id=$1",[r.requestId]);
   assert.equal((await f.request('/api/social/posts/'+id+'/impressions',{user:'user',body:{id:randomUUID(),context:'feed',requestId:r.requestId}})).status,404);
  });
  await t.test('REC-S09 time spoofing, cross-owner updates and duplicate duration callbacks are bounded',async()=>{
   const id=randomUUID();await f.request(route+'/impressions',{user:'user',body:{id,context:'detail'}});
   assert.equal((await f.request('/api/social/impressions/'+id,{user:'other',method:'PUT',body:{visibleMs:1000}})).status,404);
   assert.equal((await f.request('/api/social/impressions/'+id,{user:'user',method:'PUT',body:{visibleMs:120001}})).status,400);
   await f.query("UPDATE social_impressions SET created_at=now()-interval '3 seconds' WHERE id=$1",[id]);await Promise.all(Array.from({length:12},()=>f.request('/api/social/impressions/'+id,{user:'user',method:'PUT',body:{visibleMs:120000}})));
   const row=(await f.query('SELECT visible_ms FROM social_impressions WHERE id=$1',[id])).rows[0];assert.ok(row.visible_ms<6000);assert.ok(row.visible_ms>=3000);
   const before=row.visible_ms;await f.request('/api/social/impressions/'+id,{user:'user',method:'PUT',body:{visibleMs:0}});assert.equal((await f.query('SELECT visible_ms FROM social_impressions WHERE id=$1',[id])).rows[0].visible_ms,before);
  });
  await t.test('REC-S10 corrupted model shape/digest falls back; valid real model serves and refreshes edited items',async()=>{
   const id=randomUUID(),model=createTower();await f.query("INSERT INTO recommendation_models(id,kind,scope,state,artifact,digest,metrics,cutoff) VALUES($1,'two_tower','real','active',$2,$3,'{}',now())",[id,model,artifactDigest(model)]);
   for(const p of ids)await refreshItem({query:f.query},p);let r=await recommend(f.query,{id:uid,preferences:{}});assert.equal(r.trace.models.tower,id);assert.ok(r.trace.channels.two_tower>0);
   await f.query('UPDATE posts SET revision=revision+1 WHERE id=$1',[ids[0]]);await refreshItem({query:f.query},ids[0]);assert.equal((await f.query('SELECT e.revision=p.revision ok FROM recommendation_embeddings e JOIN posts p ON p.id=e.post_id WHERE e.model_id=$1 AND p.id=$2',[id,ids[0]])).rows[0].ok,true);
   model.user=[];await f.query('UPDATE recommendation_models SET artifact=$2,digest=$3 WHERE id=$1',[id,model,artifactDigest(model)]);assert.equal((await recommend(f.query,{id:uid,preferences:{}})).trace.models.tower,null);
   await f.query('DELETE FROM recommendation_models WHERE id=$1',[id]);
  });
  await t.test('REC-S11 temporal samples use frozen vectors, ignore late outcomes, deduplicate repeated user/post exposure',async()=>{
   const p=await post('单独的训练帖子'),vector=profileVector({}, {interests:['人文']}),request=randomUUID(),day=86400000,at=new Date(Date.now()-30*day);
   const parts={coarse:.4,affinity:.2,author:0,fresh:.3,quality:.4,city:0,seen:0,tower:0};
   await f.query("INSERT INTO recommendation_requests(id,user_id,profile_version,user_vector,context,candidate_ids,trace,algorithm,created_at) VALUES($1,$2,0,$3,'{}',$4,$5,'strict',$6)",[request,uid,vector,[p],{items:[{id:p,revision:1,parts}]},at]);
   for(let n=0;n<3;n++){const id=randomUUID(),date=new Date(at.getTime()+n*1000);await f.query("INSERT INTO social_impressions(id,user_id,post_id,context,visible_ms,created_at) VALUES($1,$2,$3,'feed',5000,$4)",[id,uid,p,date]);await f.query('INSERT INTO recommendation_exposures(id,request_id,user_id,post_id,position,item_vector,visible_ms,created_at) VALUES($1,$2,$3,$4,0,$5,5000,$6)',[id,request,uid,p,vector,date]);}
   await f.query("INSERT INTO recommendation_outcomes(user_id,post_id,kind,active,occurred_at) VALUES($1,$2,'save',true,$3)",[uid,p,new Date(at.getTime()+9*day)]);
   await f.query('UPDATE recommendation_items SET vector=$2 WHERE post_id=$1',[p,Array(96).fill(0)]);
   const samples=(await trainingSamples(f.query,'real')).filter(s=>s.postId===p);assert.equal(samples.length,1);assert.equal(samples[0].label,0);assert.deepEqual(samples[0].item,vector);assert.deepEqual(samples[0].parts,parts);
   await f.query("INSERT INTO recommendation_outcomes(user_id,post_id,kind,active,occurred_at) VALUES($1,$2,'like',true,$3)",[uid,p,new Date(at.getTime()+7*day)]);
   assert.equal((await trainingSamples(f.query,'real')).find(s=>s.postId===p).label,0,'exactly seven days is outside the first exposure label window');
   await f.query("INSERT INTO recommendation_outcomes(user_id,post_id,kind,active,occurred_at) VALUES($1,$2,'like',true,$3)",[uid,p,new Date(at.getTime()+7*day-1)]);
   assert.equal((await trainingSamples(f.query,'real')).find(s=>s.postId===p).label,1,'one millisecond before the boundary is valid');
   await f.query("INSERT INTO recommendation_outcomes(user_id,post_id,kind,active,occurred_at) VALUES($1,$2,'not_interested',true,$3)",[uid,p,new Date(at.getTime()+6*day)]);
   assert.equal((await trainingSamples(f.query,'real')).find(s=>s.postId===p).label,0,'explicit negative overrides a positive vote');
   await f.query("INSERT INTO recommendation_outcomes(user_id,post_id,kind,active,occurred_at) VALUES($1,$2,'not_interested',false,$3)",[uid,p,new Date(at.getTime()+6*day+1)]);
   assert.equal((await trainingSamples(f.query,'real')).find(s=>s.postId===p).label,1,'retracting negative feedback restores the remaining positive signal');
  });
  await t.test('REC-S12 satisfaction validation, ownership, rating reversal and neutral state',async()=>{
   const trip=randomUUID(),session=randomUUID();await f.query("INSERT INTO trips(id,user_id,title,request,plan,status) VALUES($1,$2,'评价测试','{}','{}','completed')",[trip,uid]);await f.query("INSERT INTO journey_sessions(id,user_id,request) VALUES($1,$2,'{}')",[session,uid]);await f.query('INSERT INTO recommendation_trip_sources(session_id,user_id,post_id,trip_id) VALUES($1,$2,$3,$4)',[session,uid,ids[0],trip]);
   const url='/api/journey/trips/'+trip+'/feedback';for(const rating of [0,6,1.5,'5',null])assert.equal((await f.request(url,{user:'user',method:'PUT',body:{rating}})).status,400);
   assert.equal((await f.request(url,{user:'other',method:'PUT',body:{rating:5}})).status,404);
   for(const rating of [5,1,3]){assert.equal((await f.request(url,{user:'user',method:'PUT',body:{rating,experience:'trip'}})).status,200);const states=(await f.query("SELECT DISTINCT ON(kind) kind,active FROM recommendation_outcomes WHERE user_id=$1 AND post_id=$2 AND kind IN ('satisfied','dissatisfied') ORDER BY kind,id DESC",[uid,ids[0]])).rows;assert.equal(states.find(s=>s.kind==='satisfied').active,rating>=4);assert.equal(states.find(s=>s.kind==='dissatisfied').active,rating<=2);}
  });
  await t.test('REC-S13 schema reinstall is idempotent and preserves posts',async()=>{
   const before=(await f.query('SELECT count(*)::int n FROM posts')).rows[0].n;await f.query(await readFile(new URL('../server/recommendation/schema.sql',import.meta.url),'utf8'));assert.equal((await f.query('SELECT count(*)::int n FROM posts')).rows[0].n,before);
  });
  await t.test('REC-S14 80 concurrent impression creations enforce the 60-per-minute ceiling',async()=>{
   const responses=await Promise.all(Array.from({length:80},()=>f.request(route+'/impressions',{user:'admin',body:{id:randomUUID(),context:'detail'}})));
   assert.equal(responses.filter(r=>r.status===200).length,60);assert.equal(responses.filter(r=>r.status===429).length,20);
   assert.equal((await f.query('SELECT count(*)::int n FROM social_impressions WHERE user_id=$1',[f.users.admin.id])).rows[0].n,60);
  });
  await t.test('REC-S15 database failure is sanitized and the next request recovers',async()=>{
   failRecommendation=true;try{const r=await f.request('/api/social/feed',{user:'user'});assert.equal(r.status,500);assert.ok(!JSON.stringify(r.data).includes('private-database'));}finally{failRecommendation=false;}
   assert.equal((await f.request('/api/social/feed',{user:'user'})).status,200);
  });
  await t.test('REC-S16 real profile worker connects a saved post to both feed affinity and next-trip scoring, then reverses',async()=>{
   const reader={id:f.users.admin.id,preferences:{}},museum=await post('博物馆文物与历史'),place={name:'博物馆',category:'attraction',traits:{tourism:'museum'}};
   await f.query('DELETE FROM style_dirty_users');
   const initial=(await recommend(f.query,reader)).rows.find(p=>p.id===museum).parts.affinity;
   const initialPreferences=await recommendationPreferences(f.query,reader),initialScore=scorePlace(place,initialPreferences).total;
   const errors=[],worker=createStyleWorker({...f,afterRebuild:buildProfile,onError:e=>errors.push(e)});
   const action='/api/posts/'+museum+'/reactions';
   assert.equal((await f.request(action,{body:{kind:'save',active:true}})).status,200);
   await worker.tick();assert.deepEqual(errors,[]);
   const liked=await recommendationPreferences(f.query,reader);
   assert.ok(liked.styleWeights['人文']>0);assert.ok(scorePlace(place,liked).total>initialScore);
   assert.ok((await recommend(f.query,reader)).rows.find(p=>p.id===museum).parts.affinity>initial);
   const explicit=await recommendationPreferences(f.query,reader,{interests:['自然'],pace:'relaxed'});
   assert.deepEqual(explicit.interests,['自然']);assert.equal(explicit.pace,'relaxed');
   assert.equal((await f.request(action,{body:{kind:'save',active:false}})).status,200);await worker.tick();assert.deepEqual(errors,[]);
   assert.equal(scorePlace(place,await recommendationPreferences(f.query,reader)).total,initialScore);
   assert.equal(Object.keys((await readProfile(f.query,reader)).travel).length,0);
  });
 }finally{await f.close();}
});
