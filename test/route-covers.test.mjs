import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {staticMapParams,createStaticMapRenderer,installRouteCovers} from '../server/social/route-covers.mjs';
import {routeMap,routeViewport} from '../public/route-map.js';
import {iterationFixture} from './helpers/iteration-db.mjs';
const snapshot={days:[{stops:[{name:'故宫',country:'CN',coord_system:'GCJ02',lng:116.397,lat:39.918},{name:'景山',country:'CN',lng:116.39,lat:39.93}]}]};
const png=Buffer.from([137,80,78,71,13,10,26,10,0]);
test('map cover fits entire geographic curve and converts coordinates exactly once',()=>{
 const scene=routeMap(snapshot);assert.deepEqual(scene.stops[0].position,[116.397,39.918]);assert.notDeepEqual(scene.stops[1].position,[116.39,39.93]);
 const p=staticMapParams(snapshot);assert.equal(p.size,'480*480');assert.ok(+p.zoom>=13);assert.ok(!JSON.stringify(p).includes('key'));assert.match(p.paths,/116\.397000,39\.918000/);
 const view=routeViewport([[116,40],[121,31]]);assert.ok(view.zoom<7);assert.ok(view.location[0]>116&&view.location[0]<121);
 assert.throws(()=>staticMapParams({days:[{stops:[{lat:null,lng:0}]}]}),/坐标/);
 assert.throws(()=>staticMapParams({days:[{stops:Array(201).fill({lat:1,lng:1})}]}),/过长/);
 assert.equal(staticMapParams({days:[{stops:[{lat:1,lng:1}]}]}).zoom,'17');
});
test('provider failures never expose secrets and images and pending work are bounded',async()=>{
 const render=createStaticMapRenderer({env:{AMAP_KEY:'PRIVATE'},schedule:fn=>fn(),fetchImage:async()=>new Response(png,{headers:{'content-type':'image/png'}})});
 assert.deepEqual(await render(staticMapParams(snapshot)),png);
 const bad=createStaticMapRenderer({env:{AMAP_KEY:'PRIVATE'},schedule:fn=>fn(),fetchImage:async()=>{throw Error('PRIVATE in URL');}});
 await assert.rejects(bad({}),e=>e.status===502&&!e.message.includes('PRIVATE'));
 const big=createStaticMapRenderer({env:{AMAP_KEY:'PRIVATE'},schedule:fn=>fn(),fetchImage:async()=>new Response(new Uint8Array(2*1024*1024+1),{headers:{'content-type':'image/png'}})});
 await assert.rejects(big({}),/过大/);
 const waits=[];const limited=createStaticMapRenderer({env:{AMAP_KEY:'PRIVATE'},schedule:()=>new Promise((resolve,reject)=>waits.push(reject))});
 const jobs=Array.from({length:24},()=>limited({}).catch(()=>{}));await assert.rejects(limited({}),e=>e.status===429);waits.forEach(reject=>reject(Error('cancel')));await Promise.all(jobs);
});
test('cover authorization precedes rendering and conditional responses',{skip:process.env.TEST_SOCIAL!=='1'},async()=>{
 const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','social/schema.sql']});let calls=0;
 try{
  installRouteCovers(f.app,{...f,render:async()=>{calls++;return png;}});await f.start();
  const post=randomUUID(),trip=randomUUID(),walk=randomUUID(),draft=randomUUID(),u=f.users.user.id;
  await f.query("INSERT INTO posts(id,user_id,title,body,snapshot) VALUES($1,$2,'路线','正文',$3)",[post,u,JSON.stringify(snapshot)]);
  await f.query("INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,'路线','{}',$3)",[trip,u,JSON.stringify(snapshot)]);
  await f.query("INSERT INTO citywalks(id,user_id,title,city,stops,distance_m) VALUES($1,$2,'路线','{}',$3,1000)",[walk,u,JSON.stringify(snapshot.days[0].stops)]);
  await f.query('INSERT INTO post_drafts(id,user_id,snapshot) VALUES($1,$2,$3)',[draft,u,JSON.stringify(snapshot)]);
  for(const [kind,id] of [['journey',trip],['citywalk',walk],['draft',draft]]){
   const path='/api/social/route-covers/'+kind+'/'+id;
   assert.equal((await f.request(path,{user:null})).status,401);
   assert.equal((await f.request(path,{user:'other'})).status,404);
   const r=await f.request(path,{user:'user'});assert.equal(r.status,200);assert.deepEqual(r.data,png);
   const before=calls;assert.equal((await f.request(path,{user:'user',headers:{'If-None-Match':r.headers.get('etag')}})).status,304);assert.equal(calls,before);
  }
  const path='/api/social/route-covers/post/'+post,r=await f.request(path,{user:'other'});assert.equal(r.status,200);
  await f.query('UPDATE posts SET hidden_at=now() WHERE id=$1',[post]);
  const before=calls;assert.equal((await f.request(path,{user:'other',headers:{'If-None-Match':r.headers.get('etag')}})).status,404);assert.equal(calls,before);
 }finally{await f.close();}
});
