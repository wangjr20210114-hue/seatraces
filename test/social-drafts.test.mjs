import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installDraftRoutes} from '../server/social/drafts.mjs';
import {installSocialMedia} from '../server/social/media.mjs';
import {installWritingRoutes,composeSuggestion,writingFacts} from '../server/social/writing.mjs';
import {installDiscoveryRoutes} from '../server/services/discovery.mjs';

test('AI cannot invent facts, visits, prices or source IDs',()=>{
 const d={snapshot:{days:[{city:'北京',stops:[{name:'故宫'}]}]}};
 const r=composeSuggestion(d,{tone:'lively',highlightIds:['day-0'],ending:'save'});
 assert.match(r.body,/故宫/);assert.match(r.body,/行程/);assert.doesNotMatch(r.body,/亲测|已经去|免费|元|分钟/);
 assert.throws(()=>composeSuggestion(d,{tone:'lively',highlightIds:['fake'],ending:'save'}));
 assert.throws(()=>composeSuggestion(d,{tone:'lively',highlightIds:[],ending:'save',body:'免票'}));
 assert.throws(()=>composeSuggestion(d,{tone:'lively',highlightIds:['day-0','day-0'],ending:'save'}));
 assert.equal(writingFacts({snapshot:{days:null}}).length,0);
});
test('social drafts, safe media, AI review and concurrent publication',{skip:process.env.TEST_SOCIAL!=='1'},async t=>{
 const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','social/schema.sql']});
 const mediaDir=await mkdtemp(path.join(os.tmpdir(),'seatraces-social-test-'));
 let writer;
 try{
  installDraftRoutes(f.app,f);installSocialMedia(f.app,{...f,mediaDir});installDiscoveryRoutes(f.app,f);
  writer=installWritingRoutes(f.app,{...f,generate:async()=>({tone:'lively',highlightIds:['day-0'],ending:'save'})});
  await f.start();
  const owner=f.users.user.id,trip=randomUUID(),draft=randomUUID();
  await f.query(`INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,'北京计划',$3,$4)`,[trip,owner,JSON.stringify({origin:'家地址',start:'2030-01-01',private:'私密答案'}),JSON.stringify({cities:[{name:'北京'}],days:[{city:'北京',date:'2030-01-01',stops:[{id:'palace',name:'故宫',lat:39.9,lng:116.4,category:'attraction',sourceRecords:[{secret:'raw'}],children:[{name:'子景点'}]}]}]})]);
  const call=(p,b,method)=>f.request(p,{user:'user',body:b,method});
  const base='/api/social/drafts/';
  await t.test('private source isolation and create idempotency',async()=>{
   assert.equal((await f.request('/api/social/drafts',{user:null,body:{id:draft}})).status,401);
   assert.equal((await f.request('/api/social/drafts',{user:'other',body:{id:randomUUID(),source:{kind:'journey',id:trip}}})).status,404);
   const r=await call('/api/social/drafts',{id:draft,source:{kind:'journey',id:trip}});assert.equal(r.status,200);
   assert.doesNotMatch(JSON.stringify(r.data.snapshot),/家地址|2030|private|sourceRecords|children|私密/);
   const retry=await call('/api/social/drafts',{id:draft});assert.equal(retry.data.id,draft);
   assert.equal((await f.request(base+draft,{user:'other'})).status,404);
   assert.equal((await f.request('/api/social/drafts',{user:'other',body:{id:draft}})).status,404);
  });
  let imageId;
  await t.test('format, ownership and EXIF-stripped photos',async()=>{
   const bad=await call(base+draft+'/media',{image:'data:image/png;base64,'+Buffer.from('<svg onload=alert(1)>').toString('base64')});assert.equal(bad.status,400);
   const bytes=await sharp({create:{width:24,height:20,channels:3,background:'#23cabb'}}).jpeg().withExif({IFD0:{Artist:'private-owner'}}).toBuffer();
   const good=await call(base+draft+'/media',{image:'data:image/jpeg;base64,'+bytes.toString('base64')});assert.equal(good.status,200);imageId=good.data.id;
   const info=await sharp(await readFile(path.join(mediaDir,imageId+'.webp'))).metadata();assert.equal(info.exif,undefined);
   assert.equal((await f.request('/api/social/media/'+imageId,{user:'other'})).status,404);
   assert.equal((await call('/api/social/media/'+imageId)).status,200);
  });
  await t.test('optimistic drafts prevent lost edits and reject foreign media',async()=>{
   const b={version:1,title:'我的路线',body:'计划去故宫',tags:['人文'],mediaIds:[imageId]};
   const rr=await Promise.all([call(base+draft,b,'PUT'),call(base+draft,{...b,body:'另一页'},'PUT')]);
   assert.deepEqual(rr.map(r=>r.status).sort(),[200,409]);
   assert.equal((await call(base+draft,{...b,version:2,mediaIds:[randomUUID()]},'PUT')).status,400);
   assert.equal((await call(base+draft,{...b,version:2,mediaIds:[imageId,imageId]},'PUT')).status,400);
   assert.equal((await call(base+draft,{...b,version:2,title:'长'.repeat(101)},'PUT')).status,400);
   assert.equal((await call(base+draft,{...b,version:2,user_id:f.users.other.id},'PUT')).status,400);
  });
  await t.test('AI suggestion does not overwrite edits and cannot publish itself',async()=>{
   const job=randomUUID(),r=await call(base+draft+'/generate',{id:job,version:2});assert.equal(r.status,202);
   await writer.drain();const j=await call('/api/social/writing/'+job);assert.equal(j.data.state,'ready');assert.equal(j.data.draft_version,2);
   assert.equal((await call(base+draft)).data.version,2);assert.equal((await f.query('SELECT count(*) n FROM posts')).rows[0].n,'0');
   assert.equal((await f.request('/api/social/writing/'+job,{user:'other'})).status,404);
  });
  let post;
  await t.test('20 simultaneous publish retries produce one publication',async()=>{
   const rr=await Promise.all(Array.from({length:20},()=>call(base+draft+'/publish',{version:2})));
   assert.ok(rr.every(r=>r.status===200),JSON.stringify(rr.find(r=>r.status!==200)));
   assert.equal(new Set(rr.map(r=>r.data.id)).size,1);post=rr[0].data.id;
   assert.equal((await f.query('SELECT count(*) n FROM posts')).rows[0].n,'1');
   assert.equal((await f.request('/api/social/media/'+imageId,{user:'other'})).status,200);
   await f.query('UPDATE posts SET hidden_at=now() WHERE id=$1',[post]);
   assert.equal((await f.request('/api/social/media/'+imageId,{user:'other'})).status,404);
   await f.query('UPDATE posts SET hidden_at=NULL WHERE id=$1',[post]);
  });
  await t.test('same trip supports separate posts; published snapshot survives source deletion',async()=>{
   const d2=randomUUID();assert.equal((await call('/api/social/drafts',{id:d2,source:{kind:'journey',id:trip}})).status,200);
   await call(base+d2,{version:1,title:'第二篇',body:'另一主题',tags:[],mediaIds:[]},'PUT');
   assert.equal((await call(base+d2+'/publish',{version:2})).status,200);
   await f.query('DELETE FROM trips WHERE id=$1',[trip]);
   assert.equal((await f.query('SELECT count(*) n FROM posts')).rows[0].n,'2');
   assert.match(JSON.stringify((await f.query('SELECT snapshot FROM posts WHERE id=$1',[post])).rows[0]),/故宫/);
  });
  await t.test('two published edits conflict instead of overwriting each other',async()=>{
   const ids=[randomUUID(),randomUUID()];
   for(const id of ids){assert.equal((await call('/api/social/drafts',{id,postId:post})).status,200);await call(base+id,{version:1,title:'更新',body:'新的内容',tags:[],mediaIds:[imageId]},'PUT');}
   const rr=await Promise.all(ids.map(id=>call(base+id+'/publish',{version:2})));assert.deepEqual(rr.map(r=>r.status).sort(),[200,409]);
  });
  await t.test('legacy publishing still works; new drafts are never exposed',async()=>{
   const id=randomUUID();await f.query(`INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,'兼容','{}',$3)`,[id,owner,JSON.stringify({cities:[],days:[]})]);
   const a=await call('/api/discovery/publish',{kind:'journey',id}),b=await call('/api/discovery/publish',{kind:'journey',id});assert.equal(a.status,200);assert.equal(a.data.id,b.data.id);
   await call('/api/social/drafts',{id:randomUUID()});const mine=await call('/api/discovery/mine');assert.equal(mine.data.items.length,3);
  });
  await t.test('bounded reads under 200 requests / 12 concurrent clients',async()=>{
   const times=[];let next=0,peak=process.memoryUsage().rss;const start=performance.now();
   await Promise.all(Array.from({length:12},async()=>{while(next++<200){const s=performance.now(),r=await call('/api/social/drafts?limit=12');assert.equal(r.status,200);assert.ok(r.data.items.length<=12);times.push(performance.now()-s);peak=Math.max(peak,process.memoryUsage().rss);}}));
   times.sort((a,b)=>a-b);t.diagnostic('SOCIAL_PRESSURE '+JSON.stringify({requests:times.length,concurrency:12,p95Ms:Math.round(times[189]),elapsedMs:Math.round(performance.now()-start),peakRssMiB:Math.round(peak/1048576)}));
  });
  await t.test('draft removal is owner/version scoped and cannot delete published posts',async()=>{
   const id=randomUUID();await call('/api/social/drafts',{id});
   assert.equal((await f.request(base+id,{user:'other',method:'DELETE',body:{version:1}})).status,404);
   assert.equal((await call(base+id,{version:2},'DELETE')).status,409);
   assert.equal((await call(base+id,{version:1},'DELETE')).status,200);
   assert.equal((await call(base+id)).status,404);
   assert.equal((await call(base+draft,{version:2},'DELETE')).status,409);
   assert.equal((await f.query('SELECT id FROM posts WHERE id=$1',[post])).rowCount,1);
  });
 }finally{await writer?.drain();await f.close();await rm(mediaDir,{recursive:true,force:true});}
});
