/* 验证景点实体识别与去重。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {deduplicateVisitPlaces,applyWishes} from '../server/domain/scenic-entities.mjs';

test('server canonical IDs prevent a second name-and-radius merge',()=>{
  const a={id:'osm:node/1',name:'同名景点',lng:116,lat:39,entityIdentity:{buildId:'canonical'}};
  const b={...a,id:'osm:node/2',lng:116.00001};
  assert.equal(deduplicateVisitPlaces([a,b]).length,2);
});
test('a merged legacy ID still carries the users wish',()=>{
  const place={id:'osm:relation/1',name:'故宫',possibleDuplicateIds:['osm:node/2'],entityIdentity:{buildId:'canonical'}};
  assert.equal(applyWishes(place,{'osm:node/2':true}).wanted,true);
});
