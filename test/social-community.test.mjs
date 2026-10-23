/* 验证社区信息流与互动。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installSocialCommunity} from '../server/social/community.mjs';
import {installCommunityInteractions} from '../server/services/community-interactions.mjs';
test('feeds, follows, visibility, pagination and bounded behavioral evidence',{skip:process.env.TEST_SOCIAL!=='1'},async t=>{
 const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','social/schema.sql']});
 try{
  installSocialCommunity(f.app,f);installCommunityInteractions(f.app,f);await f.start();
  const u=f.users.user.id,author=f.users.other.id,ids=Array.from({length:28},randomUUID);
  for(const [i,id] of ids.entries())await f.query(`INSERT INTO posts(id,user_id,title,body,snapshot,tags) VALUES($1,$2,$3,'正文','{"cities":["北京"],"days":[]}',ARRAY['人文'])`,[id,author,'路线'+i]);
  const call=(p,body,method)=>f.request(p,{user:'user',body,method});
  await t.test('guest denied, pagination is stable and not transferable',async()=>{
   assert.equal((await f.request('/api/social/feed',{user:null})).status,401);
   let r=await call('/api/social/feed?limit=12');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.items.length,12);
   const cursor=r.data.nextCursor,seen=new Set(r.data.items.map(x=>x.id));
   await f.query(`INSERT INTO posts(id,user_id,title,body,snapshot) VALUES($1,$2,'新帖','新正文','{}')`,[randomUUID(),author]);
   assert.equal((await f.request('/api/social/feed?cursor='+cursor,{user:'other'})).status,410);
   while(r.data.nextCursor){r=await call('/api/social/feed?cursor='+r.data.nextCursor);for(const p of r.data.items){assert.ok(!seen.has(p.id));seen.add(p.id);}}
   assert.equal(seen.size,28);
   assert.equal((await call('/api/social/feed?limit=99999')).status,400);
   assert.equal((await call('/api/social/feed?cursor=bad:0')).status,400);
   assert.equal((await call('/api/social/feed?scope=mine')).data.items.length,0);
  });
  await t.test('follow and unfollow are idempotent and update following feed',async()=>{
   assert.equal((await call('/api/social/feed?scope=following')).data.items.length,0);
   assert.equal((await call('/api/social/authors/'+u+'/follow',{active:true},'PUT')).status,400);
   const rr=await Promise.all(Array.from({length:15},()=>call('/api/social/authors/'+author+'/follow',{active:true},'PUT')));assert.ok(rr.every(r=>r.status===200));
   assert.equal((await f.query('SELECT count(*) n FROM user_follows')).rows[0].n,'1');
   assert.equal((await f.query('SELECT count(*) n FROM social_notifications')).rows[0].n,'1');
   const page=await call('/api/social/feed?scope=following');assert.equal(page.data.items.length,12);
   await call('/api/social/authors/'+author+'/follow',{active:false},'PUT');
   assert.equal((await call('/api/social/feed?scope=following&cursor='+page.data.nextCursor)).data.items.length,0);
  });
  await t.test('hidden and not-interested posts cannot leak from an older feed',async()=>{
   await call('/api/social/posts/'+ids[0]+'/feedback',{notInterested:true},'PUT');
   await f.query('UPDATE posts SET hidden_at=now() WHERE id=$1',[ids[1]]);
   assert.equal((await call('/api/social/posts/'+ids[1])).status,404);
   assert.equal((await call('/api/posts/'+ids[1]+'/comments',{body:'仍想评论'})).status,404);
   const r=await call('/api/social/feed?limit=30');assert.ok(!r.data.items.some(p=>[ids[0],ids[1]].includes(p.id)));
   await call('/api/social/posts/'+ids[0]+'/feedback',{notInterested:false},'PUT');
   assert.ok((await call('/api/social/feed?limit=30')).data.items.some(p=>p.id===ids[0]));
  });
  await t.test('dwell updates cannot multiply on replay or exceed elapsed wall time',async()=>{
   const id=randomUUID(),route='/api/social/posts/'+ids[2]+'/impressions';
   assert.equal((await call(route,{id,context:'detail'})).status,200);
   assert.equal((await f.request('/api/social/impressions/'+id,{user:'other',method:'PUT',body:{visibleMs:1000}})).status,404);
   await call('/api/social/impressions/'+id,{visibleMs:120000},'PUT');
   let n=(await f.query('SELECT visible_ms FROM social_impressions WHERE id=$1',[id])).rows[0].visible_ms;assert.ok(n<1000);
   await f.query("UPDATE social_impressions SET created_at=now()-interval '30 seconds' WHERE id=$1",[id]);
   await Promise.all(Array.from({length:12},()=>call('/api/social/impressions/'+id,{visibleMs:20000},'PUT')));
   assert.equal((await f.query('SELECT dwell_seconds FROM browse_events WHERE user_id=$1 AND post_id=$2',[u,ids[2]])).rows[0].dwell_seconds,20);
   await call('/api/social/impressions/'+id,{visibleMs:500},'PUT');
   assert.equal((await f.query('SELECT visible_ms FROM social_impressions WHERE id=$1',[id])).rows[0].visible_ms,20000);
   assert.equal((await call('/api/social/impressions/'+id,{visibleMs:-1},'PUT')).status,400);
  });
  await t.test('search treats percent and SQL fragments literally',async()=>{
   assert.equal((await call('/api/social/feed?q=%25')).data.items.length,0);
   assert.equal((await call('/api/social/feed?q='+encodeURIComponent("' OR 1=1--"))).data.items.length,0);
   assert.ok((await call('/api/social/feed?q='+encodeURIComponent('人文'))).data.items.length>0);
  });
  await t.test('disabled authors are unavailable through legacy writes as well as new details',async()=>{
   await f.query('UPDATE users SET disabled_at=now() WHERE id=$1',[author]);
   assert.equal((await call('/api/social/posts/'+ids[2])).status,404);
   assert.equal((await call('/api/posts/'+ids[2]+'/comments',{body:'不能继续写'})).status,404);
   assert.equal((await call('/api/posts/'+ids[2]+'/reactions',{kind:'like',active:true})).status,404);
   assert.equal((await call('/api/social/posts/'+ids[2]+'/adopt',{})).status,404);
   assert.equal((await call('/api/social/feed')).data.items.length,0);
  });
  await t.test('notifications and read state remain recipient scoped',async()=>{
   await f.query('UPDATE users SET disabled_at=NULL WHERE id=$1',[author]);
   const own=await f.request('/api/social/notifications',{user:'other'});assert.equal(own.data.items.length,1);
   const id=own.data.items[0].id;assert.equal(own.data.items[0].read_at,null);
   assert.equal((await call('/api/social/notifications')).data.items.length,0);
   await call('/api/social/notifications/'+id+'/read',{},'PUT');
   assert.equal((await f.query('SELECT read_at FROM social_notifications WHERE id=$1',[id])).rows[0].read_at,null);
   await f.request('/api/social/notifications/'+id+'/read',{user:'other',method:'PUT',body:{}});
   assert.ok((await f.query('SELECT read_at FROM social_notifications WHERE id=$1',[id])).rows[0].read_at);
  });
 }finally{await f.close();}
});
