import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {styleDimensions,aggregateEvidence,planningStyle,answerFeatures} from '../server/social/features.mjs';
import {rebuildStyle,readStyle,styleForPlanning,rankSocial,recordPlaceChoice,refreshPostFeatures,createStyleWorker,explainStyle} from '../server/social/style-store.mjs';
import {installSocialCommunity} from '../server/social/community.mjs';
import {installCommunityInteractions} from '../server/services/community-interactions.mjs';
import {scorePlace} from '../server/domain/scenic-clusters.mjs';
import {installUserInsights} from '../server/operations/user-insights.mjs';

test('style dimensions, unknowns, decay and explicit precedence',()=>{
 assert.ok(styleDimensions.length>=60);assert.equal(new Set(styleDimensions.map(d=>d.key)).size,styleDimensions.length);
 assert.deepEqual(answerFeatures({}),{});
 const now=Date.now(),e={origin:'p1',dimension:'interest.museum',value:1,weight:.2,observed_at:new Date(now)};
 assert.ok(aggregateEvidence([e],{now})[0].confidence<.1);
 assert.equal(aggregateEvidence([{...e,observed_at:new Date(now-400*86400000)}],{now}).length,0);
 assert.ok(aggregateEvidence([{...e,weight:3}],{now})[0].confidence>aggregateEvidence([{...e,weight:3,observed_at:new Date(now-90*86400000)}],{now})[0].confidence);
 const p=planningStyle([{dimension:'interest.museum',value:1,confidence:.9}],{pace:'full',interests:['人文']},{pace:'relaxed',interests:['自然']});
 assert.equal(p.pace,'relaxed');assert.deepEqual(p.interests,['自然']);assert.equal(p.budget,undefined);
 const sight={id:'museum',name:'博物馆',category:'attraction',traits:{tourism:'museum'}};
 const baseline=scorePlace(sight,{}),ranked=scorePlace(sight,{styleWeights:{人文:999,艺术:999}});
 assert.equal(ranked.total-baseline.total,4);
});

test('social preferences form a reversible, bounded and owner-scoped loop',{skip:process.env.TEST_SOCIAL!=='1'},async t=>{
 const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','agent/schema.sql','social/schema.sql','social/style-schema.sql']});
 try{
  installSocialCommunity(f.app,{...f,rank:(rows,user)=>rankSocial(f.query,rows,user)});installCommunityInteractions(f.app,f);installUserInsights(f.app,{...f,readInferred:id=>explainStyle(f.query,id)});await f.start();
  const uid=f.users.user.id,author=f.users.other.id,own=randomUUID(),museum=randomUUID(),park=randomUUID();
  const snap=name=>({cities:['北京'],days:[{stops:[{id:name,name,category:'attraction',lat:39.9,lng:116.4}]}]});
  for(const [id,u,name,tags] of [[own,uid,'自己的博物馆',['人文']],[museum,author,'博物馆',['人文']],[park,author,'公园',['自然']]]){
   await f.query('INSERT INTO posts(id,user_id,title,body,snapshot,tags) VALUES($1,$2,$3,$3,$4,$5)',[id,u,name,JSON.stringify(snap(name)),tags]);
   await refreshPostFeatures({query:f.query},id);
  }
  const call=(path,body,method)=>f.request(path,{user:'user',body,method});
  const rebuild=()=>f.transaction(c=>rebuildStyle(c,uid));
  const evidence=()=>f.query('SELECT * FROM user_style_evidence WHERE user_id=$1',[uid]).then(r=>r.rows);
  await t.test('own posts and comments do not become preference evidence',async()=>{
   await call('/api/posts/'+own+'/reactions',{kind:'save',active:true});
   await call('/api/posts/'+museum+'/comments',{body:'这里其实很挤，我不推荐'});
   await rebuild();assert.equal((await evidence()).length,0);
  });
  await t.test('save/like/view same post count once; un-save and clear browsing reverse evidence',async()=>{
   await call('/api/posts/'+museum+'/reactions',{kind:'save',active:true});await call('/api/posts/'+museum+'/reactions',{kind:'like',active:true});
   await f.query('INSERT INTO browse_events(user_id,post_id,dwell_seconds) VALUES($1,$2,120)',[uid,museum]);
   await rebuild();const e=(await evidence()).filter(x=>x.dimension==='interest.museum');assert.equal(e.length,1);assert.equal(e[0].weight,3);
   await call('/api/posts/'+museum+'/reactions',{kind:'save',active:false});await call('/api/posts/'+museum+'/reactions',{kind:'like',active:false});
   await rebuild();assert.equal((await evidence()).find(x=>x.dimension==='interest.museum').weight,.2);
   await f.query('DELETE FROM browse_events WHERE user_id=$1',[uid]);await rebuild();assert.equal((await evidence()).length,0);
  });
  await t.test('negative feedback wins, reverses on undo, hidden posts invalidate evidence',async()=>{
   await call('/api/posts/'+museum+'/reactions',{kind:'save',active:true});
   await call('/api/social/posts/'+museum+'/feedback',{notInterested:true},'PUT');await rebuild();assert.ok((await evidence()).every(x=>x.value<0));
   await call('/api/social/posts/'+museum+'/feedback',{notInterested:false},'PUT');await rebuild();assert.ok((await evidence()).every(x=>x.value>0));
   await f.query('DELETE FROM style_dirty_users');await f.query('UPDATE posts SET hidden_at=now() WHERE id=$1',[museum]);
   assert.ok((await f.query('SELECT user_id FROM style_dirty_users WHERE user_id=$1',[uid])).rowCount);await rebuild();assert.equal((await evidence()).length,0);
   await f.query('UPDATE posts SET hidden_at=NULL WHERE id=$1',[museum]);
  });
  await t.test('generated facts stay facts; current trip answers and confirmed memory win',async()=>{
   const id=randomUUID();await f.query('INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,$3,$4,$5)',[id,uid,'计划',JSON.stringify({interests:['自然'],pace:'relaxed',private:'SECRET'}),JSON.stringify(snap('博物馆'))]);
   await rebuild();const es=await evidence();assert.ok(es.some(e=>e.origin==='trip:'+id&&e.dimension==='interest.park'));assert.ok(!es.some(e=>e.origin==='trip:'+id&&e.dimension==='interest.museum'));
   const facts=(await f.query('SELECT features FROM trip_features WHERE source_id=$1',[id])).rows[0].features;assert.ok(facts.values['interest.museum']);assert.ok(!JSON.stringify(facts).includes('SECRET'));
   await f.query("INSERT INTO user_travel_memory(user_id,dimension,value,strength,confidence,evidence,source) VALUES($1,'pace','\"full\"',1,1,'明确选择','user_confirmed')",[uid]);
   const profile=await styleForPlanning(f.query,{id:uid,preferences:{pace:'balanced',interests:['人文']}},{pace:'relaxed',interests:['自然']});
   assert.equal(profile.pace,'relaxed');assert.deepEqual(profile.interests,['自然']);assert.equal(profile.budget,undefined);
  });
  await t.test('wishes do not multiply on repeat and removal clears only that evidence',async()=>{
   const place={id:'wish-museum',name:'博物馆',category:'attraction'};
   for(let i=0;i<10;i++)await recordPlaceChoice({query:f.query},{userId:uid,place});await rebuild();assert.equal((await evidence()).filter(e=>e.origin==='choice:'+place.id).length,1);
   await recordPlaceChoice({query:f.query},{userId:uid,place,value:0});await rebuild();assert.ok(!(await evidence()).some(e=>e.origin==='choice:'+place.id));
  });
  await t.test('adoption validates visible route, is idempotent and requires new dates',async()=>{
   const path='/api/social/posts/'+museum+'/adopt';const rs=await Promise.all(Array.from({length:12},()=>call(path,{})));assert.ok(rs.every(r=>r.status===200&&r.data.requiresNewDates));
   assert.equal((await f.query('SELECT count(*) n FROM social_adoptions WHERE user_id=$1',[uid])).rows[0].n,'1');
   assert.equal((await f.request(path,{user:null,body:{}})).status,401);await f.query('UPDATE posts SET hidden_at=now() WHERE id=$1',[museum]);assert.equal((await call(path,{})).status,404);await f.query('UPDATE posts SET hidden_at=NULL WHERE id=$1',[museum]);
  });
  await t.test('feed ordering and next-place ranking consume same preference with bounded influence',async()=>{
   await rebuild();const rows=(await f.query('SELECT * FROM posts WHERE id=ANY($1::uuid[])',[[park,museum]])).rows;
   const ranked=await rankSocial(f.query,rows,{id:uid,preferences:{interests:['人文']}});assert.equal(ranked.rows[0].id,museum);
   const p=await styleForPlanning(f.query,{id:uid,preferences:{}});assert.ok(p.styleWeights['人文']>0);
   const base={name:'博物馆',category:'attraction',traits:{tourism:'museum'}};assert.ok(scorePlace(base,p).total>scorePlace(base,{}).total);
   const explain=await explainStyle(f.query,uid);assert.ok(explain.dimensions.length>=60);assert.ok(explain.inferred.every(r=>!r.dimension.startsWith('budget.')));assert.ok(!JSON.stringify(explain).includes('SECRET'));
  });
  await t.test('worker serializes, consumes dirty users and survives cascading account deletion',async()=>{
   const endpoint='/api/admin/users/'+uid+'/preferences';
   assert.equal((await f.request(endpoint,{user:null})).status,401);assert.equal((await call(endpoint)).status,403);
   const shown=await f.request(endpoint);assert.equal(shown.status,200);assert.ok(shown.data.inferred.length);assert.ok(shown.data.evidence.length);assert.ok(!JSON.stringify(shown.data).includes('SECRET'));
   const errors=[],w=createStyleWorker({...f,onError:e=>errors.push(e)});await Promise.all(Array.from({length:10},()=>w.tick()));assert.deepEqual(errors,[]);
   await f.query('DELETE FROM users WHERE id=$1',[author]);await rebuild();assert.ok(!(await evidence()).some(e=>e.origin.startsWith('post:')));
   await f.query('DELETE FROM users WHERE id=$1',[uid]);assert.equal((await f.query('SELECT count(*) n FROM user_style_dimensions WHERE user_id=$1',[uid])).rows[0].n,'0');
  });
 }finally{await f.close();}
});
