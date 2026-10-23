/* 验证地点资料质量统计。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installPlaceQuality,qualityPlace,coverageSummary} from '../server/operations/place-quality.mjs';
test('place quality preserves category policy and distinct source/site/parent evidence',()=>{
  const p=qualityPlace({id:'osm:way/1',name:'景点',category:'attraction',source:'OSM',facts:{openingHours:{value:'08:00-17:00',status:'verified',sourceUrl:'javascript:alert(1)'},fee:{status:'needs_review',evidence:'PRIVATE'}},geometricHierarchy:{depth:2,childCount:3},siteHierarchy:{parentIds:['osm:relation/1']}});
  assert.equal(p.hasHours,true);assert.equal(p.parent.depth,2);assert.equal(p.site.parents.length,1);assert.equal(p.facts[0].sourceUrl,null);assert.deepEqual(p.issues,['facts_need_review']);assert.ok(!JSON.stringify(p).includes('PRIVATE'));
  assert.ok(!qualityPlace({name:'餐厅',category:'food',source:'OSM'}).issues.includes('opening_unknown'));
  assert.equal(qualityPlace({name:'景点',category:'attraction',hours:{}}).hasHours,false);
  assert.ok(!JSON.stringify(coverageSummary({status:'live',build:{summary:{backup:'/private/key',canonicalPlaces:100}}})).includes('private'));
});
test('quality coverage and bounded lookup never confuse business rows with remote whole-catalog data',{skip:process.env.TEST_OPERATIONS!=='1'},async t=>{
  const f=await iterationFixture({schemas:['schema.sql']});let calls=0;
  const osm={id:'osm:way/1',name:'太和殿',source:'OpenStreetMap',category:'heritage',parentId:'osm:relation/2',geometricHierarchy:{depth:2,childCount:0},siteHierarchy:{parentIds:[]}};
  const source=async(path,params)=>{calls++;if(path==='/site-coverage')throw Error('PRIVATE_SECRET');if(path==='/places')return {status:'snapshot',items:[osm]};if(path==='/place')return {status:'live',item:osm};if(path==='/hierarchy')return {status:'live',ancestors:[{name:'故宫博物院'}],children:[]};return {status:'live',rows:4566067,build:{build_id:'b1',summary:{canonicalPlaces:4500000,backup:'PRIVATE_PATH'}}};};
  installPlaceQuality(f.app,{...f,catalogRequest:source});
  try{await f.start();
    await t.test('PQ01 local counts separate and one failed remote endpoint does not break others',async()=>{
      const l=(await f.request('/api/admin/places/quality')).data;assert.equal(l.scope,'business_database_only');assert.equal(l.total,0);
      const c=(await f.request('/api/admin/places/coverage')).data;assert.equal(c.reports[0].rows,4566067);assert.equal(c.reports[1].status,'unavailable');assert.equal(c.reports[2].status,'live');assert.ok(!JSON.stringify(c).includes('PRIVATE'));assert.equal(calls,4);
    });
    await t.test('PQ02 cached query stays marked cached; no fake parent inference or unbounded paths',async()=>{
      const s=(await f.request('/api/admin/places/search?q=太和殿')).data;assert.equal(s.status,'snapshot');assert.equal(s.items[0].parent.id,'osm:relation/2');assert.equal(s.bounded,true);
      const d=(await f.request('/api/admin/places/inspect?id=osm:way/1')).data;assert.equal(d.hierarchy.ancestors[0].name,'故宫博物院');assert.equal(d.item.site.parents.length,0);
      assert.equal((await f.request('/api/admin/places/inspect?id=osm:../../secret')).status,400);assert.equal((await f.request('/api/admin/places/quality',{user:'user'})).status,403);
    });
    await t.test('PQ03 80 concurrent refreshes reuse four bounded coverage requests',async()=>{
      const before=calls;let n=0;await Promise.all(Array.from({length:8},async()=>{while(n<80){n++;assert.equal((await f.request('/api/admin/places/coverage')).status,200);}}));assert.equal(calls,before);
    });
  }finally{await f.close();}
});
