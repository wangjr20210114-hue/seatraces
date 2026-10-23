/* 验证社区内容审核。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installModeration} from '../server/operations/moderation.mjs';
import {installCommunityInteractions,visiblePost} from '../server/services/community-interactions.mjs';
import {installDiscoveryRoutes} from '../server/services/discovery.mjs';
test('content moderation enforces actual public APIs, reversible actions and idempotent reports',{skip:process.env.TEST_OPERATIONS!=='1'},async t=>{
  const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','operations/moderation-schema.sql']});let failAudit=false;
  installModeration(f.app,{...f,events:{append:async(...args)=>{if(failAudit&&args[0].action==='content.visibility')throw Error('audit unavailable');return f.events.append(...args);}}});installCommunityInteractions(f.app,f);installDiscoveryRoutes(f.app,f);
  f.app.get('/api/test/feed',f.auth,async(req,res)=>res.json((await f.query(`SELECT p.id FROM posts p WHERE ${visiblePost()}`)).rows));
  const trip=randomUUID();let post,comment,report;
  const change=(kind,id,hidden,version)=>f.request('/api/admin/content/'+kind+'/'+id+'/visibility',{method:'PATCH',body:{hidden,version,reason:'inaccurate',confirmation:'change-visibility'}});
  try{await f.query("INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,'分享路线','{\"interests\":[\"自然\"]}','{\"cities\":[{\"name\":\"上海\"}],\"days\":[]}')",[trip,f.users.user.id]);await f.start();
    post=(await f.request('/api/discovery/publish',{user:'user',body:{kind:'journey',id:trip}})).data.id;
    await f.request('/api/posts/'+post+'/comments',{user:'other',body:{body:'待检查的评论'}});comment=(await f.request('/api/posts/'+post+'/comments',{user:'user'})).data[0].id;
    await t.test('CM01 duplicate reports collapse, owners cannot inspect other reports, no automatic hiding',async()=>{
      const responses=await Promise.all(Array.from({length:16},()=>f.request('/api/content/reports',{user:'other',body:{id:randomUUID(),kind:'posts',targetId:post,reason:'inaccurate'}})));
      assert.ok(responses.every(r=>r.status===201));assert.equal(new Set(responses.map(r=>r.data.id)).size,1);report=responses[0].data.id;
      assert.equal((await f.request('/api/test/feed',{user:'user'})).data.length,1);assert.equal((await f.request('/api/admin/content-reports',{user:'other'})).status,403);
      assert.equal((await f.request('/api/admin/content-reports')).data.items.length,1);
    });
    await t.test('CM02 simultaneous moderators: one transition; hidden comments vanish but remain stored',async()=>{
      const results=await Promise.all(Array.from({length:12},()=>change('comments',comment,true,1)));assert.equal(results.filter(r=>r.status===200).length,1);assert.ok(results.every(r=>[200,409].includes(r.status)));
      assert.equal((await f.request('/api/posts/'+post+'/comments',{user:'user'})).data.length,0);assert.equal((await f.query('SELECT count(*)::int n FROM comments')).rows[0].n,1);
      assert.equal((await change('comments',comment,false,2)).status,200);assert.equal((await f.request('/api/posts/'+post+'/comments',{user:'user'})).data.length,1);
    });
    await t.test('CM03 hide blocks feed, comments, new reactions and view; reshare cannot bypass',async()=>{
      assert.equal((await change('posts',post,true,1)).status,200);assert.equal((await f.request('/api/test/feed',{user:'user'})).data.length,0);
      for(const [suffix,body]of [['comments',{body:'no'}],['reactions',{kind:'like',active:true}],['view',{seconds:10}]])assert.equal((await f.request('/api/posts/'+post+'/'+suffix,{user:'user',body})).status,404);
      assert.equal((await f.request('/api/posts/'+post+'/comments',{user:'user'})).status,404);
      await f.request('/api/discovery/publish',{user:'user',body:{kind:'journey',id:trip}});assert.equal((await f.request('/api/test/feed',{user:'user'})).data.length,0);
      assert.equal((await f.request('/api/posts/'+post+'/reactions',{user:'user',body:{kind:'like',active:false}})).status,200);
    });
    await t.test('CM04 failed audit rolls back restoration; report decision version checked',async()=>{
      failAudit=true;assert.equal((await change('posts',post,false,2)).status,500);assert.equal((await f.request('/api/test/feed',{user:'user'})).data.length,0);failAudit=false;
      assert.equal((await change('posts',post,false,2)).status,200);
      const body={state:'resolved',version:1,confirmation:'resolve-report'};assert.equal((await f.request('/api/admin/content-reports/'+report,{method:'PATCH',body})).status,200);assert.equal((await f.request('/api/admin/content-reports/'+report,{method:'PATCH',body})).status,409);
      assert.equal((await f.request('/api/admin/content/posts/'+post,{user:null})).status,401);
      assert.equal((await f.request('/api/admin/content/posts/'+post,{user:'user'})).status,403);
      assert.equal((await f.query("SELECT count(*)::int n FROM operation_events WHERE action='content.visibility'")).rows[0].n,4);
    });
    await t.test('CM05 120 moderation list reads at concurrency 8',async()=>{
      let n=0;const ms=[];await Promise.all(Array.from({length:8},async()=>{while(n<120){n++;const start=performance.now();assert.equal((await f.request('/api/admin/content')).status,200);ms.push(performance.now()-start);}}));ms.sort((a,b)=>a-b);console.log('PRESSURE content: 120 requests/concurrency 8, p95='+Math.round(ms[114])+'ms');
    });
  }finally{await f.close();}
});
