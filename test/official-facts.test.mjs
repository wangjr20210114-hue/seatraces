import test from 'node:test';
import assert from 'node:assert/strict';
import {factValidity,applyFactValidity} from '../server/domain/fact-validity.mjs';
import {officialSourceURL,officialText,fetchOfficialPage,seedOfficialSources,createOfficialFacts,installOfficialFactRoutes} from '../server/services/official-facts.mjs';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installMaintenance} from '../server/operations/maintenance.mjs';
import {randomUUID} from 'node:crypto';
test('field validity excludes stale, future and unreviewed facts without inventing current values',()=>{
 const fact={value:'09:00-17:00',source:'官网',evidence:{reviewStatus:'accepted',retrievedAt:'2026-10-17T00:00:00Z',reviewAfter:'2026-10-20T00:00:00Z',validFrom:'2026-10-18',validThrough:'2026-10-19'}};
 assert.equal(factValidity(fact,'2026-10-18',Date.parse('2026-10-18')).usable,true);
 assert.equal(factValidity(fact,'2026-10-21',Date.parse('2026-10-18')).status,'outside_valid_dates');
 assert.equal(applyFactValidity({facts:{openingHours:fact}},'2026-10-18',Date.parse('2026-10-21')).facts.openingHours.value,null);
 assert.equal(factValidity({...fact,evidence:{...fact.evidence,reviewStatus:'pending'}},'2026-10-18',Date.parse('2026-10-18')).usable,false);
});
test('official fetch rejects redirects, private/unregistered hosts and oversized bodies; strips scripts',async()=>{
 for(const url of ['http://www.dpm.org.cn/a','https://127.0.0.1/','https://www.dpm.org.cn.evil.test/','https://www.dpm.org.cn/a?url=x','https://u@www.dpm.org.cn/'])assert.throws(()=>officialSourceURL(url));
 assert.equal(officialText('<script>evil()</script><p>营业</p> <b>时间</b>'),'营业 时间');
 let options;const normal=await fetchOfficialPage('https://www.dpm.org.cn/Visit.html',{fetchImpl:async(u,o)=>{options=o;return new Response('<p>'+'开放资料 '.repeat(50)+'</p>',{headers:{'content-type':'text/html'}});}});
 assert.equal(options.redirect,'error');assert.ok(normal.sha256.length===64);
 await assert.rejects(fetchOfficialPage('https://www.dpm.org.cn/Visit.html',{fetchImpl:async()=>new Response('x'.repeat(512001),{headers:{'content-type':'text/html'}})}),e=>e.status===413);
});
test('official refresh uses demand priority and review gates; changed and expired evidence cannot constrain plans',
 {skip:process.env.TEST_OFFICIAL_FACTS!=='1',timeout:60000},async()=>{
 const f=await iterationFixture({schemas:['schema.sql','operations/maintenance-schema.sql','place-descriptions-schema.sql','place-facts-schema.sql']});let maintenance;
 try{
  await seedOfficialSources(f.query);await f.query("UPDATE official_place_sources SET enabled=false WHERE id<>'palace-visit'");
  let calls=0,modelCalls=0,changed=false;
  const text='故宫参观指南：每日开放时间09:00-17:00，预约参观。'+ '请以官方公告为准。'.repeat(20);
  const service=createOfficialFacts({query:f.query,transaction:f.transaction,fetchPage:async()=>{calls++;return {text:changed?text+'临时调整':text,sha256:changed?'b'.repeat(64):'a'.repeat(64)};},enabled:()=>true,
   model:async()=>{modelCalls++;return {facts:[{field:'openingHours',value:'09:00-17:00',evidenceId:'palace-visit',quote:'每日开放时间09:00-17:00'}]};}});
  installOfficialFactRoutes(f.app,{query:f.query,transaction:f.transaction,events:f.events});
  maintenance=installMaintenance(f.app,{query:f.query,transaction:f.transaction,events:f.events,extraExecutors:{place_refresh:service.refresh}});await f.start();
  await service.demand(['osm:relation/9511883','osm:relation/9511883']);
  const r=await service.refresh();assert.equal(r.pending,1);assert.equal(modelCalls,1);
  assert.equal((await f.request('/api/admin/places/fact-reviews',{user:'user'})).status,403);
  const pending=(await f.request('/api/admin/places/fact-reviews')).data.items[0];assert.ok(pending.fact.evidence.quote);
  assert.equal((await service.overlay({id:'osm:relation/9511883'})).facts.openingHours,undefined);
  const review={version:1,decision:'accept',confirmation:'review-official-fact'};
  const accepted=await f.request('/api/admin/places/fact-reviews/'+pending.id,{body:review});assert.equal(accepted.status,200);
  assert.equal((await f.request('/api/admin/places/fact-reviews/'+pending.id,{body:review})).status,409);
  assert.equal((await service.overlay({id:'osm:relation/9511883'})).factQuality.openingHours.usable,true);
  await service.refresh();assert.equal(calls,1);
  await f.query("UPDATE official_place_sources SET refresh_after=now()-interval '1 minute'");
  assert.equal((await service.refresh()).unchanged,1);assert.equal(modelCalls,1);
  changed=true;await f.query("UPDATE official_place_sources SET refresh_after=now()-interval '1 minute'");await service.refresh();
  assert.equal((await service.overlay({id:'osm:relation/9511883'})).factQuality.openingHours.usable,false);assert.equal(modelCalls,2);
  await f.query("UPDATE official_place_sources SET refresh_after=now()-interval '1 minute'");await service.refresh();
  assert.equal((await service.overlay({id:'osm:relation/9511883'})).factQuality.openingHours.usable,false,'an unchanged new page must not restore an older unreviewed hash');
  const next=(await f.request('/api/admin/places/fact-reviews')).data.items[0];
  await f.query("UPDATE official_fact_reviews SET fact=jsonb_set(fact,'{evidence,reviewAfter}','\"2020-01-01\"') WHERE id=$1",[next.id]);
  assert.equal((await f.request('/api/admin/places/fact-reviews/'+next.id,{body:review})).status,409);
  const rows=await Promise.all(Array.from({length:20},()=>service.overlayMany([{id:'osm:relation/9511883'}])));assert.ok(rows.every(x=>x[0].facts.openingHours.value===null));
  const task={id:randomUUID(),kind:'place_refresh',confirmation:'run-task'};
  assert.equal((await f.request('/api/admin/maintenance/tasks',{user:'user',body:task})).status,403);
  assert.equal((await f.request('/api/admin/maintenance/tasks',{body:task})).status,202);
  assert.equal((await f.request('/api/admin/maintenance/tasks',{body:{...task,id:randomUUID()}})).status,409);
  await maintenance.worker.tick();assert.equal((await f.request('/api/admin/maintenance/tasks/'+task.id)).data.state,'completed');
  const cancelId=randomUUID();await f.request('/api/admin/maintenance/tasks',{body:{...task,id:cancelId}});
  assert.equal((await f.request('/api/admin/maintenance/tasks/'+cancelId+'/cancel',{body:{version:1,confirmation:'cancel-task'}})).data.state,'cancelled');
 }finally{await maintenance?.close();await f.close();}
});
