import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createJourneyRecovery,overlayPendingWishes} from '../public/journey-recovery.js';
import {saveJourneyWish,restoredCitySelection} from '../server/services/journey-service.mjs';
import {journeyFixture} from './helpers/journey-db.mjs';
const id='bf1ad140-9569-4d84-a6ba-aeb26b0af26b';
function memory(){const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
const progress=()=>({active:true,step:4,origin:{label:'北京',lat:39.9,lng:116.4},cities:[{id:'shanghai',name:'上海'}],start:'2026-11-01',end:'2026-11-02',session:{id},clientSessionId:id,selections:{shanghai:['area-1','area-2']},questions:[{id:'companion',title:'和谁去？',type:'single',options:[{value:'parents',label:'父母'}]}],answers:{companion:'parents'},answerKeys:['companion'],pendingWishes:{'osm:node/1':true}});
test('every selection survives a new recovery instance immediately, without unload or timers',()=>{
 const storage=memory(),store=createJourneyRecovery({storage,userId:'a'}),p=progress();
 assert.equal(store.save(p),true);const loaded=createJourneyRecovery({storage,userId:'a'}).read();
 assert.equal(loaded.step,4);assert.deepEqual(loaded.selections,p.selections);assert.deepEqual(loaded.answers,p.answers);assert.deepEqual(loaded.pendingWishes,p.pendingWishes);
 p.pendingWishes['osm:node/1']=false;store.save(p);assert.equal(createJourneyRecovery({storage,userId:'a'}).read().pendingWishes['osm:node/1'],false);
});
test('owners are isolated and a corrupted or foreign record is never restored',()=>{
 const storage=memory(),a=createJourneyRecovery({storage,userId:'a'}),b=createJourneyRecovery({storage,userId:'b'});a.save(progress());assert.equal(b.read(),null);
 storage.setItem(b.key,storage.getItem(a.key));assert.equal(b.read(),null);storage.setItem(a.key,'{broken');assert.equal(a.read(),null);
 assert.throws(()=>createJourneyRecovery({storage,userId:''}));
});
test('large catalogs, credentials and generated plans are excluded, failed storage is explicit',()=>{
 const storage=memory(),store=createJourneyRecovery({storage,userId:'a'}),p=progress();
 p.catalog={raw:'x'.repeat(35*1024*1024)};p.trip={plan:'private'};p.password='secret';store.save(p);
 const raw=storage.getItem(store.key);assert.ok(raw.length<3000);assert.ok(!raw.includes('secret'));assert.ok(!raw.includes('catalog'));assert.ok(!raw.includes('private'));
 const blocked=createJourneyRecovery({storage:{...storage,setItem(){throw Error('Quota exceeded');}},userId:'a'});assert.equal(blocked.save(p),false);assert.ok(store.read());
});
test('pending positive and negative wishes overlay recovered parent and child selections',()=>{
 const catalog={clusters:[{members:[{id:'parent',ownWanted:true,children:[{id:'child',ownWanted:false}]}]}]};
 overlayPendingWishes(catalog,{parent:false,child:true});const p=catalog.clusters[0].members[0];assert.equal(p.ownWanted,false);assert.equal(p.wanted,true);assert.equal(p.children[0].wanted,true);
 overlayPendingWishes(catalog,{child:false});assert.equal(p.wanted,false);
});
test('saved group IDs and wishes recover even when the separate map-boundary provider is down',async()=>{
 const snapshot={clusters:[{id:'original-group',members:[{id:'a',children:[{id:'child'}]},{id:'b',ownWanted:true}]}]};
 const r=await restoredCitySelection(snapshot,{id:'city'},{child:true,b:false},async()=>{throw Error('Provider offline');});
 assert.equal(r.boundary.status,'unavailable');assert.deepEqual(r.boundary.cityRings,[]);assert.equal(r.clusters[0].id,'original-group');
 assert.equal(r.clusters[0].members[0].wanted,true);assert.equal(r.clusters[0].members[1].wanted,false);
 assert.equal(snapshot.clusters[0].members[0].wanted,undefined,'stored snapshot is not mutated');
});
test('5,000 synchronous updates stay bounded and restore the last exact choice',t=>{
 const storage=memory(),store=createJourneyRecovery({storage,userId:'a'}),p=progress(),started=performance.now();
 for(let i=0;i<5000;i++){p.answers.walkingLimitKm=i%2?3:5;assert.equal(store.save(p),true);}
 assert.equal(store.read().answers.walkingLimitKm,3);assert.ok(storage.getItem(store.key).length<3000);
 t.diagnostic(JSON.stringify({updates:5000,elapsedMs:Math.round(performance.now()-started),bytes:storage.getItem(store.key).length}));
});
test('concurrent wish retries produce one committed choice signal and rollback stays atomic',{skip:process.env.TEST_OPERATIONS!=='1'},async()=>{
 const f=await journeyFixture(),userId=f.users.user.id,place={id:'place',possibleDuplicateIds:['alias']};let signals=0;
 const recordWish=async()=>{signals++;};
 try{
  await Promise.all(Array.from({length:20},()=>f.transaction(db=>saveJourneyWish(db,{userId,place,wanted:true,recordWish}))));
  assert.equal(signals,1);assert.equal((await f.query('SELECT count(*)::int n FROM user_place_wishes WHERE user_id=$1 AND wanted',[userId])).rows[0].n,2);
  await f.transaction(db=>saveJourneyWish(db,{userId,place,wanted:false,recordWish}));assert.equal(signals,2);
  await assert.rejects(f.transaction(db=>saveJourneyWish(db,{userId,place,wanted:true,recordWish:async()=>{throw Error('signal failed');}})),/signal failed/);
  assert.equal((await f.query('SELECT count(*)::int n FROM user_place_wishes WHERE user_id=$1 AND wanted',[userId])).rows[0].n,0);
 }finally{await f.close();}
});
