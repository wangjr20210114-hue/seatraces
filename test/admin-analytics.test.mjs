/* 验证活跃指标与业务漏斗。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {analyticsWindow,installAnalytics} from '../server/operations/analytics.mjs';
const now=()=>new Date('2026-10-16T04:00:00Z');
test('analytics uses Beijing natural days and rejects invalid/unbounded ranges',()=>{
  const w=analyticsWindow({},now());assert.equal(w.from,'2026-10-10');assert.equal(w.to,'2026-10-16');assert.equal(w.start,'2026-10-09T16:00:00.000Z');assert.equal(w.end,now().toISOString());
  assert.throws(()=>analyticsWindow({from:'2026-09-01'},now()));assert.throws(()=>analyticsWindow({to:'2026-10-17'},now()));assert.throws(()=>analyticsWindow({from:'2026-10-16',to:'2026-10-15'},now()));
});
test('operational statistics honor event coverage, users, ordered flows and permission boundaries',{skip:process.env.TEST_OPERATIONS!=='1'},async t=>{
  const schemas=['schema.sql','citywalk-schema.sql','agent/schema.sql','operations/inbox-schema.sql','citywalk-expansion-schema.sql','operations/product-schema.sql','operations/analytics-schema.sql'];
  const f=await iterationFixture({schemas});installAnalytics(f.app,{...f,now});
  const range='?from=2026-10-08&to=2026-10-16',root='/api/admin/analytics/';
  const owner=f.users.user.id,other=f.users.other.id,newUser=randomUUID();
  async function event(user,type,at,{flow=randomUUID(),resource=randomUUID()}={}){
    await f.query("INSERT INTO product_events(user_id,event_type,resource_type,resource_id,flow_id,source,created_at) VALUES($1,$2::text,split_part($2::text,'.',1),$3,$4,'database',$5)",[user,type,resource,flow,at]);
  }
  try{
    await f.query("UPDATE analytics_settings SET started_at='2026-10-01T00:00:00Z'");
    await f.query("UPDATE users SET created_at='2026-10-08T01:00:00Z'");
    await f.query("UPDATE users SET analytics_excluded=true WHERE id=$1",[other]);
    await f.query("INSERT INTO users(id,username,password_hash,nickname,created_at) VALUES($1,'fresh_user','invalid','PRIVATE_NICKNAME','2026-10-16T01:00:00Z')",[newUser]);
    for(const u of [owner,other,f.users.admin.id]){
      await f.query("INSERT INTO trips(id,user_id,title,request,plan,created_at) VALUES($1,$2,'PRIVATE_TRIP','{}','{}','2026-10-08T02:00:00Z')",[randomUUID(),u]);
      await f.query("INSERT INTO citywalks(id,user_id,title,city,stops,distance_m,created_at) VALUES($1,$2,'PRIVATE_WALK','{}','[{},{}]',1000,'2026-10-08T02:00:00Z')",[randomUUID(),u]);
    }
    await f.query('DELETE FROM product_events');
    const good=randomUUID(),bad=randomUUID(),open=randomUUID(),walk=randomUUID(),action=randomUUID();
    for(const [type,at] of [['started','2026-10-08T01:00Z'],['candidates_loaded','2026-10-08T02:00Z'],['questions_ready','2026-10-08T03:00Z'],['completed','2026-10-09T02:00Z'],['completed','2026-10-09T03:00Z']])await event(owner,'journey.'+type,at,{flow:good});
    for(const [type,at] of [['started','2026-10-08T04:00Z'],['completed','2026-10-08T05:00Z'],['candidates_loaded','2026-10-08T06:00Z'],['questions_ready','2026-10-08T07:00Z']])await event(owner,'journey.'+type,at,{flow:bad});
    await event(owner,'journey.started','2026-10-15T01:00Z',{flow:open});
    await event(newUser,'journey.completed','2026-10-16T02:00Z',{flow:open});
    await event(other,'journey.started','2026-10-08T01:00Z');
    await event(f.users.admin.id,'journey.started','2026-10-08T01:00Z');
    await event(owner,'citywalk.started','2026-10-08T01:00Z',{flow:walk});await event(owner,'citywalk.saved','2026-10-09T01:00Z',{flow:walk});
    await event(owner,'agent.action_prepared','2026-10-08T01:00Z',{resource:action});await event(owner,'agent.action_executing','2026-10-08T02:00Z',{resource:action});await event(owner,'agent.action_completed','2026-10-08T03:00Z',{resource:action});
    await f.query("INSERT INTO operation_events(user_id,kind,action,created_at) VALUES($1,'navigation','home.open','2026-10-08T16:00:00Z')",[owner]);
    await f.query("INSERT INTO operation_events(user_id,kind,action,created_at) VALUES($1,'navigation','home.open','2026-10-15T01:00:00Z')",[owner]);
    f.app.use((error,req,res,next)=>{if(!error.status&&error.name!=='ZodError')console.error('Analytics fixture error:',error.message);next(error);});
    await f.start();
    await t.test('AN01 zero-filled daily trend, staff/test exclusions and Beijing boundary',async()=>{
      const r=await f.request(root+'overview'+range);assert.equal(r.status,200,JSON.stringify(r.data));
      assert.deepEqual(r.data.totals,{users:2,active:2,registered:2,trips:1,walks:1});assert.equal(r.data.series.length,9);
      assert.equal(r.data.series.find(d=>d.day==='2026-10-09').active,1);assert.equal(r.data.series.find(d=>d.day==='2026-10-10').active,0);
      assert.equal(r.data.coverage.partial,false);assert.equal(JSON.stringify(r.data).includes('PRIVATE'),false);assert.equal(JSON.stringify(r.data).includes(owner),false);
      assert.equal((await f.request(root+'overview?from=2026-01-01')).status,400);
    });
    await t.test('AN02 deduplicated ordered funnels and separate-user flow ids',async()=>{
      const r=await f.request(root+'funnels'+range);assert.equal(r.status,200,JSON.stringify(r.data));
      assert.deepEqual(r.data.steps.map(s=>s.count),[3,2,2,1]);assert.equal(r.data.maturedFlows,2);assert.equal(r.data.observingFlows,1);assert.equal(r.data.steps.at(-1).conversion,33.33);
      for(const kind of ['citywalk','agent']){const r=await f.request(root+'funnels'+range+'&kind='+kind);assert.equal(r.status,200,JSON.stringify(r.data));assert.ok(r.data.steps.every(s=>s.count===1));}
      assert.equal((await f.request(root+'funnels'+range+'&kind=DROP')).status,400);
    });
    await t.test('AN03 exact-day retention does not turn immature/missing coverage into zero',async()=>{
      let r=await f.request(root+'retention'+range);assert.equal(r.status,200,JSON.stringify(r.data));
      let old=r.data.items.find(c=>c.day==='2026-10-08');assert.equal(old.registered,1);assert.deepEqual(old.periods.map(p=>p.status),['complete','complete','observing']);assert.equal(old.periods[0].rate,100);assert.equal(old.periods[1].rate,100);
      assert.ok(r.data.items.find(c=>c.day==='2026-10-16').periods.every(p=>p.rate===null));
      await f.query("UPDATE analytics_settings SET started_at='2026-10-09T01:00:00Z'");
      r=await f.request(root+'retention'+range);old=r.data.items.find(c=>c.day==='2026-10-08');assert.equal(old.periods[0].status,'unavailable');assert.equal(old.periods[0].rate,null);
      await f.query("UPDATE analytics_settings SET started_at='2026-10-01T00:00:00Z'");
    });
    await t.test('AN04 overlapping groups have no identity leakage; scope changes are audited and reversible',async()=>{
      let r=await f.request(root+'segments'+range);assert.equal(r.status,200);assert.equal(r.data.counts.planners,1);assert.equal(r.data.counts.agent_users,1);assert.equal(r.data.personalIdentifiersIncluded,false);
      const path='/api/admin/users/'+owner+'/analytics';
      assert.equal((await f.request(path,{method:'PATCH',body:{excluded:true}})).status,400);
      assert.equal((await f.request(path,{method:'PATCH',body:{excluded:true,confirmation:'change-analytics-scope'}})).status,200);
      assert.equal((await f.request(root+'overview'+range)).data.totals.trips,0);
      assert.equal((await f.query("SELECT count(*)::int n FROM operation_events WHERE action='user.analytics_scope' AND resource_id=$1",[owner])).rows[0].n,1);
      await f.request(path,{method:'PATCH',body:{excluded:false,confirmation:'change-analytics-scope'}});
      assert.equal((await f.request(root+'scope?q=fixture_user')).data.items[0].analytics_excluded,false);
    });
    await t.test('AN05 role isolation, aggregate-only analyst and 160 requests at concurrency 8',async()=>{
      for(const endpoint of ['overview','funnels','retention','segments','scope']){
        assert.equal((await f.request(root+endpoint+range,{user:null})).status,401);assert.equal((await f.request(root+endpoint+range,{user:'user'})).status,403);
      }
      await f.request('/api/admin/access/members/'+other,{method:'PUT',body:{role:'analyst',version:0,confirmation:'change-role'}});
      const login=await f.request('/api/auth/admin/login',{user:null,body:{username:f.users.other.username,password:f.password}});assert.equal(login.status,200);
      const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');f.users.other.cookie=cookie;
      assert.equal((await f.request(root+'overview'+range,{user:'other'})).status,200);
      assert.equal((await f.request(root+'scope',{user:'other'})).status,403);
      let index=0;const durations=[];
      await Promise.all(Array.from({length:8},async()=>{while(index<160){const path=['overview','funnels','retention','segments'][index++%4],start=performance.now();const r=await f.request(root+path+range,{user:'other'});assert.equal(r.status,200);assert.equal(JSON.stringify(r.data).includes(owner),false);durations.push(performance.now()-start);}}));
      durations.sort((a,b)=>a-b);console.log('PRESSURE analytics: 160 requests/concurrency 8, p95='+Math.round(durations[Math.floor(durations.length*.95)])+'ms');
    });
    await t.test('AN06 larger dataset: 6000 full flows, duplicate-safe totals and bounded concurrent queries',async()=>{
      await f.query(`INSERT INTO product_events(user_id,event_type,resource_type,resource_id,flow_id,source,created_at)
        SELECT $1,('journey.'||x.kind),'journey',md5(g::text),md5(g::text)::uuid,'database',
          '2026-10-15T02:00:00Z'::timestamptz+(g*4+x.ord)*interval '1 second'
        FROM generate_series(1,6000) g CROSS JOIN (VALUES('started',0),('candidates_loaded',1),('questions_ready',2),('completed',3)) x(kind,ord)`,[owner]);
      await f.query('ANALYZE product_events');
      const duration=[];let i=0;
      await Promise.all(Array.from({length:4},async()=>{while(i<12){i++;const start=performance.now();const r=await f.request(root+'funnels'+range);assert.equal(r.status,200);assert.deepEqual(r.data.steps.map(s=>s.count),[6003,6002,6002,6001]);duration.push(performance.now()-start);}}));
      duration.sort((a,b)=>a-b);console.log('PRESSURE analytics dataset: 24000 new events/6000 flows, 12 queries/concurrency 4, p95='+Math.round(duration.at(-1))+'ms');
    });
  }finally{await f.close();}
});
