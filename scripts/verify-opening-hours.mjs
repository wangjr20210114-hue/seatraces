/* 检查地点开放时间的查询结果。 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const base='http://127.0.0.1:8787/api',records=[];
async function call(path,params,expected=200){
  const start=performance.now(),response=await fetch(base+path+'?'+new URLSearchParams(params)),body=await response.json();
  assert.equal(response.status,expected);records.push({path,params,httpStatus:response.status,elapsedMs:Math.round((performance.now()-start)*100)/100,result:body});return body;
}
const date='2026-10-12';
const temple=await call('/catalog/opening',{id:'osm:way/173154847',date});
assert.equal(temple.cacheStatus,'live');assert.equal(temple.source,'OpenStreetMap');assert.equal(temple.status,'parsed');
assert.deepEqual(temple.intervals.map(x=>[x.start,x.end]),[['06:00','17:00']]);
const tower=await call('/catalog/opening',{id:'osm:relation/4247312',date});
assert.equal(tower.cacheStatus,'live');assert.equal(tower.status,'parsed');assert.equal(tower.editorialNote.source.includes('官网'),true);
assert.deepEqual(tower.intervals.map(x=>[x.start,x.end]),[['09:00','23:00']]);
const hotels=await call('/catalog/search',{category:'accommodation',region:'japan',lat:35.68,lng:139.75,radius:3000,limit:30});
assert.equal(hotels.status,'live');const hotel=hotels.items.find(p=>!p.opening_hours);assert.ok(hotel,'Need a source POI with missing opening hours');
const missing=await call('/catalog/opening',{id:hotel.id,date});assert.equal(missing.status,'missing');assert.equal(missing.dayState,'unknown');assert.deepEqual(missing.intervals,[]);
await call('/catalog/opening',{id:'osm:way/173154847',date:'2026-02-30'},400);
await call('/catalog/opening',{id:'not-an-osm-id',date},400);
await call('/catalog/opening',{id:'osm:node/99999999999999999999',date},404);
const report={checkedAt:new Date().toISOString(),checks:7,passed:true,note:'Live OSM source-rule parsing only; no actual venue opening or provider API claims.',records};
await writeFile('validation/opening-hours-live-20261011.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:true,checks:7,missingHoursPlace:{id:hotel.id,name:hotel.name},httpMs:records.filter(r=>r.httpStatus===200).map(r=>r.elapsedMs)}));
