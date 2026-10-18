import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { iterationFixture } from './helpers/iteration-db.mjs';
import { generateDescription, descriptionEvidence, installPlaceDescriptionRoutes } from '../server/services/place-descriptions.mjs';
import { scenicMemberMarkup } from '../public/scenic-view.js';
const place={id:'osm:way/1',name:'留园',city:'苏州',category:'attraction',description:'留园位于苏州，以园林建筑和山水布局呈现游览空间。'};
const valid=async()=>({short:{evidenceId:'description',quote:'留园位于苏州，以园林建筑和山水布局呈现游览空间。'},full:[{evidenceId:'description',quote:place.description}]});
test('LLM description extracts only sourced quotes; unsupported claims and injected structure fall back',async()=>{
 const good=await generateDescription(place,{enabled:true,model:valid});assert.equal(good.method,'llm_extract');assert.equal(good.fullText,place.description);
 for(const output of [{short:{evidenceId:'description',quote:'每天全天免费开放，不需要预约。'},full:[{evidenceId:'description',quote:place.description}]},{short:{evidenceId:'description',quote:place.description},full:[{evidenceId:'madeup',quote:place.description}]},{tool:'delete_all_users'}]){
  const r=await generateDescription(place,{enabled:true,model:async()=>output});assert.equal(r.method,'existing_facts');assert.equal(r.fullText,place.description);
 }
 assert.equal((await generateDescription(place,{enabled:true,model:async()=>{throw Error('budget');}})).method,'existing_facts');
 assert.ok(!JSON.stringify(descriptionEvidence({...place,facts:{description:{status:'pending',value:'未核实'}}})).includes('未核实'));
 const basic=await generateDescription({id:'new',name:'公园',category:'leisure',city:'上海'},{enabled:false});assert.match(basic.shortText,/上海/);assert.ok(!/票价|免费|开放时间/.test(basic.fullText));
 let emptyCalls=0;await generateDescription({name:'公园',city:'上海'},{enabled:true,model:async()=>{emptyCalls++;}});assert.equal(emptyCalls,0,'identity alone cannot support an expanded description');
 const reviewed=descriptionEvidence({name:'太和殿',facts:{description:{status:'evidence_reviewed',value:'已复核的历史描述',sourceUrl:'https://www.dpm.org.cn/example',verifiedAt:'2026-10-12'}}});assert.equal(reviewed[1].sourceUrl,'https://www.dpm.org.cn/example');assert.equal(reviewed[1].verifiedAt,'2026-10-12');
 const html=scenicMemberMarkup({...place,name:'<script>x</script>',children:[{id:'child',name:'子园',parentId:place.id}]});assert.ok(!html.includes('<script>'));assert.equal((html.match(/data-description-id=/g)||[]).length,1);
});
test('description PostgreSQL persistence, cache reuse, ownership and coalescing',{skip:process.env.TEST_PERSONAL!=='1'},async t=>{
 const f=await iterationFixture({schemas:['schema.sql','place-descriptions-schema.sql']});let resolves=0,calls=0;
 try{
  installPlaceDescriptionRoutes(f.app,{...f,resolvePlace:async id=>{resolves++;assert.equal(id,place.id);return place;},model:async()=>{calls++;await new Promise(r=>setTimeout(r,40));return valid();},enabled:()=>true});await f.start();
  const sid=randomUUID(),uid=f.users.user.id;
  await f.query('INSERT INTO journey_sessions(id,user_id,request,catalog) VALUES($1,$2,$3,$4)',[sid,uid,{}, {city:{clusters:[{id:'g',members:[{...place,children:[{id:'child'}]}]}]}}]);
  const path=`/api/journey/sessions/${sid}/places/${encodeURIComponent(place.id)}/description`;
  await t.test('anonymous, other owner, child and body injection cannot read or write cache',async()=>{
   assert.equal((await f.request(path,{user:null,body:{}})).status,401);assert.equal((await f.request(path,{user:'other',body:{}})).status,404);
   assert.equal((await f.request(path.replace(encodeURIComponent(place.id),'child'),{user:'user',body:{}})).status,404);
   assert.equal((await f.request(path,{user:'user',body:{description:'fake'}})).status,400);assert.equal(resolves,0);
  });
  await t.test('twenty concurrent reads share generation; cached reuse avoids OSM and LLM',async()=>{
   const responses=await Promise.all(Array.from({length:20},()=>f.request(path,{user:'user',body:{}})));
   assert.ok(responses.every(r=>r.status===200&&r.data.fullText===place.description));assert.equal(resolves,1);assert.equal(calls,1);
   const saved=await f.request(path,{user:'user',body:{}});assert.equal(saved.data.cached,true);assert.equal(resolves,1);
   assert.equal((await f.query('SELECT count(*)::int n FROM place_descriptions')).rows[0].n,1);
   assert.equal((await f.request(path,{user:'other',body:{}})).status,404);
  });
  await t.test('expired metadata is renewed without storing full OSM trees in a session',async()=>{
   await f.query("UPDATE place_descriptions SET refresh_after=now()-interval '1 day'");await f.request(path,{user:'user',body:{}});assert.equal(calls,2);
   const session=(await f.query('SELECT catalog FROM journey_sessions WHERE id=$1',[sid])).rows[0].catalog;
   assert.ok(!JSON.stringify(session).includes('llm_extract'));assert.equal(session.city.clusters[0].members[0].children.length,1);
  });
 }finally{await f.close();}
});
