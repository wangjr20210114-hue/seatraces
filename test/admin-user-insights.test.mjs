import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installUserInsights} from '../server/operations/user-insights.mjs';
const schemas=['schema.sql','citywalk-schema.sql','agent/schema.sql','operations/inbox-schema.sql','citywalk-expansion-schema.sql'];

test('user overview joins owned data, distinguishes evidence and audits sensitive reads',{skip:process.env.TEST_OPERATIONS!=='1'},async t=>{
  const f=await iterationFixture({schemas});
  try{
    installUserInsights(f.app,{query:f.query,events:f.events});
    const owner=f.users.user.id,other=f.users.other.id,trip=randomUUID(),foreignTrip=randomUUID(),walk=randomUUID(),convo=randomUUID(),campaign=randomUUID();
    const request={cities:[{name:'上海'}],start:'2026-10-20',end:'2026-10-21',origin:{lat:31.123456,lng:121.123456,label:'PRIVATE_ORIGIN'}};
    await f.query(`INSERT INTO trips(id,user_id,title,request,plan,status) VALUES($1,$2,'上海两日行程',$3,$4,'completed'),($5,$6,'OTHER_PRIVATE_TRIP','{}','{}','planned')`,[trip,owner,JSON.stringify(request),JSON.stringify({days:[{stops:[{id:'place:1',name:'计划景点'}]},{stops:[]}]}),foreignTrip,other]);
    await f.query(`INSERT INTO trip_versions(trip_id,version,plan,reason) VALUES($1,1,'{}','first'),($1,2,'{}','PRIVATE_REASON')`,[trip]);
    await f.query(`INSERT INTO citywalks(id,user_id,title,city,stops,distance_m,verified_route) VALUES($1,$2,'滨江慢走','{"name":"上海"}','[{"id":"a"},{"id":"b"}]',3456,'{"status":"verified"}')`,[walk,owner]);
    await f.query(`INSERT INTO agent_conversations(id,user_id,state) VALUES($1,$2,'{"secret":"PRIVATE_CHAT"}')`,[convo,owner]);
    await f.query(`INSERT INTO user_travel_memory(user_id,dimension,value,strength,confidence,evidence,source,expires_at) VALUES($1,'crowd','"avoid"',0.9,1,'PRIVATE_EVIDENCE','user_confirmed',now()-interval '1 day')`,[owner]);
    await f.query(`INSERT INTO user_place_wishes(user_id,place_id,wanted) VALUES($1,'osm:unknown',true),($1,'not-wanted',false),($2,'OTHER_PLACE',true)`,[owner,other]);
    await f.query(`INSERT INTO inbox_campaigns(id,created_by,title,body,audience,status) VALUES($1,$2,'旅行提醒','PRIVATE_MESSAGE_BODY','all','sent')`,[campaign,f.users.admin.id]);
    await f.query('INSERT INTO inbox_messages(campaign_id,user_id) VALUES($1,$2)',[campaign,owner]);
    await f.events.append({userId:owner,kind:'request',action:'POST /api/journey/sessions/:id/generate',status:503,durationMs:1000,requestId:randomUUID()});
    await f.start();const base='/api/admin/users/'+owner;
    await t.test('USR01 summary fields exclude credentials, precise origin and conversation content',async()=>{
      const r=await f.request(base+'/summary');assert.equal(r.status,200);const c=r.data.counts;
      assert.equal(c.trips,1);assert.equal(c.marked_completed,1);assert.equal(c.citywalks,1);assert.equal(c.wishes,1);assert.equal(c.marked_visits,0);assert.equal(c.presence_records,0);assert.equal(c.conversations,1);assert.equal(c.unread_messages,1);assert.equal(c.recent_failures,1);
      const raw=JSON.stringify(r.data);for(const s of ['password_hash','token_hash','PRIVATE','OTHER_PRIVATE','31.123456'])assert.ok(!raw.includes(s),s);
      assert.equal((await f.query("SELECT count(*)::int n FROM operation_events WHERE action='user.summary_read' AND resource_id=$1 AND user_id=$2",[owner,f.users.admin.id])).rows[0].n,1);
    });
    await t.test('USR02 timeline labels genuine business timestamps and contains no invented old clicks',async()=>{
      let r=await f.request(base+'/timeline');assert.equal(r.status,200);
      assert.equal(r.data.historicalClicksReconstructed,false);
      assert.equal(r.data.items.filter(e=>e.action==='trip.saved').length,1);
      assert.equal(r.data.items.filter(e=>e.action==='trip.version_saved').length,1);
      assert.equal(r.data.items.filter(e=>e.action==='citywalk.saved').length,1);
      assert.equal(r.data.items.find(e=>e.action==='trip.saved').source,'business');
      assert.equal(r.data.items.find(e=>e.status===503).source,'operation');
      r=await f.request(base+'/timeline?source=business&limit=1');assert.equal(r.data.items.length,1);assert.equal(r.data.hasMore,true);
      const next=await f.request(base+'/timeline?source=business&limit=1&offset=1');assert.notEqual(next.data.items[0].id,r.data.items[0].id);
      assert.equal((await f.request(base+'/timeline?from=2026-02-30')).status,400);
      assert.equal((await f.request(base+'/timeline?from=2026-01-01&to=2026-10-16')).status,400);
      assert.equal((await f.request(base+'/timeline?source=business&type=request')).data.items.length,0);
    });
    await t.test('USR03 all tabs paginate and read only the requested user',async()=>{
      const trips=await f.request(base+'/trips');assert.equal(trips.data.items[0].start_date,'2026-10-20');assert.equal(trips.data.items[0].day_count,2);assert.equal(trips.data.items[0].id,trip);
      assert.equal((await f.request(base+'/citywalks')).data.items[0].distance_m,3456);
      const prefs=await f.request(base+'/preferences');assert.equal(prefs.data.confirmed[0].expired,true);assert.deepEqual(prefs.data.inferred,[]);assert.ok(!JSON.stringify(prefs.data).includes('PRIVATE_EVIDENCE'));
      const wishes=await f.request(base+'/visits');assert.equal(wishes.data.items[0].place_id,'osm:unknown');assert.equal(wishes.data.items.length,1);
      assert.deepEqual((await f.request(base+'/visits?kind=presence')).data.items,[]);
      assert.deepEqual((await f.request(base+'/visits?kind=marked')).data.items,[]);
      assert.equal((await f.request(base+'/messages')).data.items[0].title,'旅行提醒');assert.ok(!JSON.stringify((await f.request(base+'/messages')).data).includes('PRIVATE_MESSAGE_BODY'));
      for(const path of ['trips','citywalks','visits','messages'])assert.equal((await f.request(base+'/'+path+'?limit=101')).status,400);
      assert.equal((await f.request(base+'/visits?kind=anything')).status,400);
      assert.equal((await f.request('/api/admin/users/'+randomUUID()+'/summary')).status,404);
    });
    await t.test('USR04 management roles and anonymous access enforced on every tab',async()=>{
      for(const path of ['summary','timeline','trips','citywalks','preferences','visits','messages']){
        assert.equal((await f.request(base+'/'+path,{user:null})).status,401);
        assert.equal((await f.request(base+'/'+path,{user:'other'})).status,403);
      }
      await f.query("INSERT INTO admin_memberships(user_id,role) VALUES($1,'operator')",[other]);
      const login=await f.request('/api/auth/admin/login',{user:null,body:{username:f.users.other.username,password:f.password}});
      const cookie=login.headers.get('set-cookie').split(';')[0];
      for(const path of ['summary','timeline','trips','citywalks','preferences','visits','messages'])assert.equal((await f.request(base+'/'+path,{user:null,headers:{Cookie:cookie}})).status,403);
    });
    await t.test('USR05 160 mixed detail reads, concurrency 8, exact account isolation',async()=>{
      const times=[];let index=0;const paths=['summary','timeline','trips','citywalks','preferences','visits','messages'];
      await Promise.all(Array.from({length:8},async()=>{while(index<160){const n=index++,start=performance.now();const r=await f.request(base+'/'+paths[n%paths.length]);assert.equal(r.status,200,JSON.stringify(r.data));assert.ok(!JSON.stringify(r.data).includes('OTHER_PRIVATE_TRIP'));times.push(performance.now()-start);}}));
      times.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({requests:160,concurrency:8,errors:0,p95Ms:Math.round(times[Math.floor(times.length*.95)]),externalCalls:0}));
    });
  }finally{await f.close();}
});
