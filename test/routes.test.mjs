import test from 'node:test';
import assert from 'node:assert/strict';
import { transitAlternatives,pathAlternatives,rankAlternatives,mainlandEligible } from '../server/route-model.mjs';
import { catalogQuery } from '../server/catalog.mjs';
const convert=s=>String(s||'').split(';').filter(Boolean).map(p=>p.split(',').map(Number).reverse());
const step={instruction:'沿道路前进',polyline:'120,31;120.01,31.01',distance:'50',cost:{duration:'40'}};
const bus=(name,from,to)=>({bus:{buslines:[{name,departure_stop:{name:from},arrival_stop:{name:to},duration:'600',distance:'5000',polyline:step.polyline}]}});
test('street turns are nested inside one walking leg',()=>{
  const r=pathAlternatives([{steps:[step,step],distance:'100',cost:{duration:'80'}}],'walking',convert)[0];
  assert.equal(r.segments.length,1);assert.equal(r.segments[0].steps.length,2);assert.equal(r.minutes,2);
  assert.equal(r.transferCount,0);assert.equal(r.direct,false);
});
test('v5 nested geometry is retained for walking and transit, with both coordinate systems',()=>{
  const nested={...step,polyline:{polyline:step.polyline}};
  const vehicle=bus('2路','甲','乙');vehicle.bus.buslines[0].polyline={polyline:step.polyline};
  const transit=transitAlternatives([{segments:[{walking:{steps:[nested]}},vehicle,{walking:{steps:[nested]}}]}],convert)[0];
  const walking=pathAlternatives([{steps:[nested]}],'walking',convert)[0];
  for(const route of [transit,walking]){
    assert.equal(route.hasCompleteGeometry,true);
    for(const s of route.segments){assert.deepEqual(s.mapPolyline,[[120,31],[120.01,31.01]]);assert.deepEqual(s.polyline,[[31,120],[31.01,120.01]]);}
  }
});
test('walk / metro / walk / bus / walk retains each transfer and missing duration',()=>{
  const w={walking:{steps:[step],distance:'50'}};
  const r=transitAlternatives([{cost:{duration:'1800'},segments:[w,bus('地铁1号线','甲','乙'),w,bus('20路','乙','丙'),w]}],convert)[0];
  assert.deepEqual(r.segments.map(x=>x.mode),['walk','metro','walk','bus','walk']);
  assert.equal(r.transferCount,1);assert.equal(r.walkingMeters,150);assert.equal(r.minutes,30);
  assert.equal(r.segments[0].minutes,null);assert.equal(r.segments[1].boarding,'甲');
});
test('taxi and train legs are not silently discarded',()=>{
  const r=transitAlternatives([{segments:[{taxi:{distance:'100',drivetime:'60',polyline:step.polyline}},{railway:{id:'G1',name:'G1',time:'3600'}}]}],convert)[0];
  assert.deepEqual(r.segments.map(x=>x.mode),['taxi','train']);assert.equal(r.hasCompleteGeometry,false);
});
test('ranking preserves distinction between quickest and fewest transfers',()=>{
  const a={durationSeconds:100,walkingMeters:60,transferCount:2,segments:[{mode:'bus',instruction:'a'}]},
    b={durationSeconds:200,walkingMeters:20,transferCount:0,segments:[{mode:'bus',instruction:'b'}]};
  assert.equal(rankAlternatives([a,b,a],'fastest').length,2);
  assert.equal(rankAlternatives([a,b],'fastest')[0],a);
  assert.equal(rankAlternatives([a,b],'fewTransfers')[0],b);
});
test('overseas coordinates are not treated as mainland coordinates',()=>{
  assert.equal(mainlandEligible({country:'JP',lat:35,lng:139}),false);
  assert.equal(mainlandEligible({extract_region:'china',lat:22.28,lng:114.15}),false);
  assert.equal(mainlandEligible({extract_region:'china',lat:31.24,lng:121.49}),true);
});
test('catalog rejects incomplete, broad or invalid nearby searches',()=>{
  for(const b of [{q:'湖'},{lat:31},{q:'西湖',lng:'NaN',lat:31},{q:'西湖',radius:-1}]) assert.equal(catalogQuery.safeParse(b).success,false);
  assert.equal(catalogQuery.safeParse({lat:31,lng:121,category:'scenic'}).success,true);
});
