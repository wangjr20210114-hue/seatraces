/* 验证推荐结果随用户行为的变化。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rerank,primaryTopic,recommend} from '../server/recommendation/engine.mjs';
import {recommendationContext} from '../public/travel-context.js';
import {ensureCurrentProfile} from '../server/recommendation/freshness.mjs';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installSocialCommunity} from '../server/social/community.mjs';
import {installCommunityInteractions} from '../server/services/community-interactions.mjs';
import {refreshItem} from '../server/recommendation/profiles.mjs';
test('relevance retains space for other topics and authors, without inventing diversity in a single-topic corpus',()=>{
 const rows=Array.from({length:60},(_,i)=>({id:String(i),user_id:String(i%5),route_key:'r'+i,
  fine:i<40?.95:.55,parts:{fresh:.5,quality:.8},features:{values:{[i<40?'interest.garden':i<50?'interest.art':'interest.food']:1}}}));
 const out=rerank(rows).slice(0,10);assert.ok(out.filter(p=>primaryTopic(p)==='interest.garden').length<=6);
 assert.ok(new Set(out.map(primaryTopic)).size>=3);assert.ok(out.some(p=>p.rerankReason==='topic_exploration'));
 for(let i=2;i<out.length;i++)assert.ok(!(out[i].user_id===out[i-1].user_id&&out[i].user_id===out[i-2].user_id));
 assert.equal(rerank(rows.slice(0,10)).length,10);
});
test('active destination is ephemeral, bounded, owned and expires after the trip',()=>{
 const now=Date.parse('2026-10-18T08:00:00Z'),trip={user_id:'a',request:{start:'2026-10-19',end:'2026-10-20',cities:[{name:'上海'}]}};
 assert.deepEqual(recommendationContext({trip,userId:'a',now}),{city:'上海'});
 assert.deepEqual(recommendationContext({trip,userId:'b',now}),{});
 assert.deepEqual(recommendationContext({trip,userId:'a',now:now+4*86400000}),{});
 assert.deepEqual(recommendationContext({trip:{...trip,request:{...trip.request,start:'2027-01-01'}},userId:'a',now}),{});
});
test('fresh recommendation rebuilds changed evidence before serving, isolates users, and handles undo without a worker wait',
 {skip:process.env.TEST_RECOMMENDATION_ADAPT!=='1',timeout:60000},async()=>{
  const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','agent/schema.sql','social/schema.sql','social/style-schema.sql','recommendation/schema.sql']});
  try{
    installCommunityInteractions(f.app,f);
    installSocialCommunity(f.app,{...f,recommend:async(u,options)=>{await ensureCurrentProfile(f.transaction,u.id);return recommend(f.query,u,options);}});await f.start();
    const ids=[];
    for(let i=0;i<45;i++){
      const id=randomUUID(),tag=['园林','艺术','美食'][i%3];ids.push({id,tag});
      await f.query('INSERT INTO posts(id,user_id,title,body,tags,snapshot) VALUES($1,$2,$3,$3,$4,$5)',[id,f.users.other.id,tag+'内容'+i,[tag],{}]);await refreshItem({query:f.query},id);
    }
    const url='/api/social/feed',first=await f.request(url,{user:'user'});assert.equal(first.status,200);
    assert.equal((await f.request(url,{user:'user',body:{city:'上海\0',exclude:[]}})).status,400);
    const initial=(await f.query('SELECT profile_version FROM recommendation_requests WHERE id=$1',[first.data.requestId])).rows[0].profile_version;
    const selected=ids.filter(p=>p.tag==='园林').slice(0,6);
    for(const p of selected)assert.equal((await f.request('/api/posts/'+p.id+'/reactions',{user:'user',body:{kind:'save',active:true}})).status,200);
    const next=await f.request(url,{user:'user',body:{limit:10,city:'上海',exclude:selected.map(p=>p.id)}});assert.equal(next.status,200);
    const record=(await f.query('SELECT profile_version,context FROM recommendation_requests WHERE id=$1',[next.data.requestId])).rows[0];
    assert.ok(record.profile_version>initial);assert.equal(record.context.city,'上海');
    assert.equal((await f.query('SELECT 1 FROM style_dirty_users WHERE user_id=$1',[f.users.user.id])).rowCount,0);
    assert.ok((await f.query('SELECT travel FROM recommendation_profiles WHERE user_id=$1',[f.users.user.id])).rows[0].travel['interest.garden']);
    assert.ok(next.data.items.every(p=>!selected.some(x=>x.id===p.id)));
    assert.equal((await f.query('SELECT 1 FROM recommendation_profiles WHERE user_id=$1',[f.users.admin.id])).rowCount,0);
    for(const p of selected)await f.request('/api/posts/'+p.id+'/reactions',{user:'user',body:{kind:'save',active:false}});
    await f.request(url,{user:'user'});
    assert.deepEqual((await f.query('SELECT travel FROM recommendation_profiles WHERE user_id=$1',[f.users.user.id])).rows[0].travel,{});
    const results=await Promise.all(Array.from({length:12},()=>f.request(url,{user:'user',body:{limit:10,exclude:[]}})));
    assert.ok(results.every(r=>r.status===200));
  }finally{await f.close();}
});
