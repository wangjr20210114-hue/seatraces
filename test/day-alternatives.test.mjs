/* 验证单日行程备选方案。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDayAlternatives,verifyDayAlternative} from '../server/domain/day-alternatives.mjs';
const point=(id,name,lat,traits={})=>({id,name,lat,lng:121.4,category:'attraction',city:'上海',traits});
const points=[point('palace','故宫',31.2),point('museum','城市博物馆',31.201,{tourism:'museum'}),point('garden','园林',31.202,{leisure:'garden'}),point('art','艺术馆',31.203,{tourism:'gallery'}),point('park','公园',31.204,{leisure:'park'})];
const trip=()=>({id:'trip',version:1,request:{pace:'balanced',interests:['人文'],transport:'balanced',revisit:'either'},plan:{cities:[],days:[
 {index:0,date:'2027-06-20',city:'上海',cityId:'sh',stops:points.slice(0,3).map((p,i)=>({...p,arrive:['09:00','11:00','14:00'][i],leave:['10:30','12:00','15:30'][i],duration_min:90})),timeBudget:{start:540,end:1080,transitionMinutes:8,mealMinutes:45}},
 {index:1,date:'2027-06-21',city:'上海',cityId:'sh',stops:[]},
]}});
test('alternative strategies differ in depth, explain choices and preserve explicit retained or locked places',async()=>{
 const t=trip();t.plan.days[0].stops[0].locked=true;const before=structuredClone(t);
 const r=await makeDayAlternatives(t,points,{day:0,keepIds:['palace'],endBy:'16:00'});
 assert.ok(r.variants.length>=2);assert.deepEqual(t,before);
 for(const v of r.variants){assert.equal(v.day.stops[0].id,'palace');assert.ok(v.day.stops.at(-1).leave<='16:00');assert.ok(v.explanations.length);assert.equal(v.metrics.status,'estimated');}
 const culture=r.variants.find(v=>v.focus==='culture'),classic=r.variants.find(v=>v.focus==='classics');assert.ok(culture&&classic);
 assert.ok(culture.day.stops.find(p=>p.id==='museum')?.duration_min>classic.day.stops.find(p=>p.id==='museum')?.duration_min);
 assert.equal((await makeDayAlternatives(t,points,{day:0,avoidIds:['palace']})).variants.length,0);
 await assert.rejects(makeDayAlternatives(t,points,{day:0,keepIds:['foreign']}),e=>e.status===400);
});
test('afternoon change preserves the morning prefix and only removes an eligible afternoon stop',async()=>{
 const t=trip();t.plan.days[0].stops.push({...points[3],arrive:'16:00',leave:'17:00',duration_min:60});
 const r=await makeDayAlternatives(t,points,{day:0,afternoonOnly:true,removeCount:1,focus:'walk'});
 assert.equal(r.variants.length,1);const v=r.variants[0];assert.equal(v.day.stops.length,3);
 assert.deepEqual(v.day.stops.slice(0,2),t.plan.days[0].stops.slice(0,2));
 const verified=await verifyDayAlternative(v,{routeLeg:async()=>({status:'live',minutes:8,walkingMeters:100})});
 assert.equal(verified.verification,'verified');assert.deepEqual(verified.day.stops.slice(0,2),t.plan.days[0].stops.slice(0,2));
});
test('real route timing can reject infeasible alternatives; missing routes never become verified',async()=>{
 const r=await makeDayAlternatives(trip(),points,{day:0,focus:'culture',endBy:'16:00'}),v=r.variants[0];
 const missing=await verifyDayAlternative(v,{routeLeg:async()=>({status:'estimated',minutes:1,walkingMeters:10})});assert.equal(missing.verification,'unavailable');
 const slow=await verifyDayAlternative(v,{routeLeg:async()=>({status:'live',minutes:300,walkingMeters:10000})});assert.equal(slow.verification,'conflict');
 const invalid=await verifyDayAlternative(v,{routeLeg:async()=>({status:'live',minutes:-10,walkingMeters:-1})});assert.equal(invalid.verification,'unavailable');
 const closed=await makeDayAlternatives(trip(),points,{day:0,keepIds:['palace']},{opening:async p=>p.id==='palace'?{status:'parsed',dayState:'closed'}:null});assert.equal(closed.variants.length,0);
});
test('corrupt legacy budget is rejected rather than producing a NaN schedule',async()=>{
 const t=trip();t.plan.days[0].timeBudget.start='invalid';await assert.rejects(makeDayAlternatives(t,points,{day:0}),e=>e.status===409);
});
test('nearby replacement keeps every other position and rejects a locked target',async()=>{
 const t=trip(),extra=point('near','附近博物馆',31.2015,{tourism:'museum'}),far=point('far','遥远博物馆',31.5,{tourism:'museum'});
 const r=await makeDayAlternatives(t,[...points,extra,far],{day:0,replaceId:'museum',focus:'classics'});
 assert.equal(r.variants.length,1);assert.equal(r.variants[0].day.stops.length,3);
 assert.equal(r.variants[0].day.stops[0].id,'palace');assert.equal(r.variants[0].day.stops[2].id,'garden');assert.notEqual(r.variants[0].day.stops[1].id,'far');
 t.plan.days[0].stops[1].locked=true;assert.equal((await makeDayAlternatives(t,[...points,extra],{day:0,replaceId:'museum'})).variants.length,0);
});
