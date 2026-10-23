/* 验证地点几何包含层级。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {overlayParentChecks} from '../server/domain/amap-parent.mjs';
import {overlayScenicHierarchy} from '../server/domain/scenic-hierarchy.mjs';
import {createOsmClient} from '../server/integrations/osm.mjs';
import {groupScenicEntities} from '../server/domain/scenic-entities.mjs';

test('geometry build parents and depth survive historic Amap and model overlays',()=>{
  const child={id:'osm:way/1',name:'Hall',parentId:'osm:relation/2',hierarchyLevel:8,
    geometricHierarchy:{buildId:'build',status:'child',depth:8},parentLookup:{status:'child',provider:'osm_geometry'}};
  const old=new Map([[child.id,{status:'root',checkedAt:'2026-10-01'}]]);
  const provider=overlayParentChecks([child],old);
  const inferred=new Map([[child.id,{status:'child',parentId:'osm:relation/3'}]]);
  const result=overlayScenicHierarchy(provider.places,inferred,{includeModelSuggestions:true});
  assert.equal(result[0].parentId,'osm:relation/2');
  assert.equal(result[0].hierarchyLevel,8);
  const unknown={...child,parentId:null,geometricHierarchy:{buildId:'build',status:'geometry_unavailable'}};
  assert.equal(overlayParentChecks([unknown],new Map([[unknown.id,{status:'child',parentId:'wrong'}]])).places[0].parentId,null);
});

test('read transport exposes complete hierarchy including all child categories',async()=>{
  const payload={item:{id:'osm:relation/1'},children:[{id:'osm:node/2',category:'food',hierarchyLevel:8}],maxDepth:8,nextCursor:null};
  const request=createOsmClient({env:{OSM_SERVICE_URL:'http://127.0.0.1:8791'},fetchImpl:async url=>{
    assert.equal(url.pathname,'/hierarchy');assert.equal(url.searchParams.get('category'),'food');
    return {ok:true,json:async()=>payload};
  }});
  assert.deepEqual(await request('/hierarchy',{id:'osm:relation/1',category:'food'}),payload);
});

test('flat scenic cards retain the real direct parent and nested depth',()=>{
  const places=['大公园','园中小园','古亭景点'].map((name,i)=>({
    id:'osm:way/'+(i+1),name,lat:30+i*.01,lng:120,category:'attraction',
    parentId:i?'osm:way/'+i:null,hierarchyLevel:i+1,
    geometricHierarchy:{buildId:'build',geometryState:'full_geometry',depth:i+1},
    parentLookup:{status:i?'child':'root',provider:'osm_geometry'},
  }));
  const cards=groupScenicEntities(places);
  assert.equal(cards.length,1);
  const leaf=cards[0].children.find(p=>p.id==='osm:way/3');
  assert.equal(leaf.parentId,'osm:way/2');
  assert.equal(leaf.hierarchyLevel,3);
  assert.equal(leaf.displayParentId,'osm:way/1');
});
