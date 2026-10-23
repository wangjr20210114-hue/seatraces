/* 测量社区接口在批量请求下的性能和资源占用。 */

import {iterationFixture} from '../test/helpers/iteration-db.mjs';
import {installSocialCommunity} from '../server/social/community.mjs';
import {rankSocial,rebuildStyle,refreshPostFeatures} from '../server/social/style-store.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {getHeapStatistics} from 'node:v8';
const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','agent/schema.sql','social/schema.sql','social/style-schema.sql']});
const out={schemaVersion:'social-pressure/1',at:new Date().toISOString(),productionAccess:false,paidCalls:0,heapLimitMiB:Math.round(getHeapStatistics().heap_size_limit/1048576),rounds:[]};
let peakHeap=0,peakRss=0,sampler;
try{
 const u=f.users.user.id,a=f.users.other.id;
 await f.query(`INSERT INTO posts(id,user_id,title,body,tags,snapshot,created_at)
 SELECT gen_random_uuid(),$1,'压力验收路线 '||n,repeat('合成测试正文 ',200),ARRAY[CASE WHEN n%2=0 THEN '人文' ELSE '自然' END],
 jsonb_build_object('cities',jsonb_build_array('北京'),'days',jsonb_build_array(jsonb_build_object('city','北京','stops',
 (SELECT jsonb_agg(jsonb_build_object('id','stress-'||i,'name',CASE WHEN n%2=0 THEN '博物馆 ' ELSE '公园 ' END||i,'category','attraction','lat',39.9+i*.0001,'lng',116.4+i*.0001)) FROM generate_series(1,30) i)))),now()-n*interval '1 minute'
 FROM generate_series(1,1200) n`,[a]);
 await f.query("INSERT INTO reactions(user_id,post_id,kind) SELECT $1,id,'save' FROM posts",[u]);
 const time=performance.now();const built=await f.transaction(c=>rebuildStyle(c,u));out.rebuild={...built,elapsedMs:Math.round(performance.now()-time)};
 const ids=(await f.query('SELECT id FROM posts ORDER BY created_at DESC LIMIT 120')).rows;
 for(const p of ids)await refreshPostFeatures({query:f.query},p.id);
 installSocialCommunity(f.app,{...f,rank:(rows,user)=>rankSocial(f.query,rows,user)});await f.start();
 sampler=setInterval(()=>{const m=process.memoryUsage();peakHeap=Math.max(peakHeap,m.heapUsed);peakRss=Math.max(peakRss,m.rss);},20);
 for(let round=0;round<4;round++){
  const times=[],sizes=[];let next=0;const total=round===0?40:200,concurrency=round===0?4:12,start=performance.now();
  await Promise.all(Array.from({length:concurrency},async()=>{while(next++<total){const s=performance.now(),r=await f.request('/api/social/feed?limit=12',{user:'user'});assert.equal(r.status,200,JSON.stringify(r.data));assert.ok(r.data.items.length<=12);times.push(performance.now()-s);sizes.push(Buffer.byteLength(JSON.stringify(r.data)));}}));
  times.sort((a,b)=>a-b);global.gc?.();out.rounds.push({round,requests:total,concurrency,errors:0,p50Ms:Math.round(times[Math.floor(times.length*.5)]),p95Ms:Math.round(times[Math.floor(times.length*.95)]),elapsedMs:Math.round(performance.now()-start),maxResponseBytes:Math.max(...sizes),afterGcHeapMiB:+(process.memoryUsage().heapUsed/1048576).toFixed(1)});
 }
 out.peakHeapMiB=Math.round(peakHeap/1048576);out.peakRssMiB=Math.round(peakRss/1048576);out.heapGrowthMiB=+(out.rounds.at(-1).afterGcHeapMiB-out.rounds[0].afterGcHeapMiB).toFixed(1);
 out.remainingFeedSessions=Number((await f.query('SELECT count(*) n FROM social_feed_sessions WHERE user_id=$1',[u])).rows[0].n);
 assert.ok(out.remainingFeedSessions<=6);assert.ok(out.peakHeapMiB<240);assert.ok(out.heapGrowthMiB<24);
 assert.ok(out.rounds.every(r=>r.p95Ms<2000));out.passed=true;
}finally{clearInterval(sampler);await f.close();out.testSchemaRemoved=true;await mkdir('validation/social-loop',{recursive:true});await writeFile('validation/social-loop/pressure.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));}
