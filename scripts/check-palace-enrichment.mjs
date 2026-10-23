/* 检查故宫资料补充后的地点与分组结果。 */

import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {groupScenicEntities} from '../server/domain/scenic-entities.mjs';
const root=new URL('../',import.meta.url);
const batch=JSON.parse(await readFile(new URL('data/editorial/palace-20261012.json',root),'utf8'));
const original=JSON.parse(await readFile(new URL('.runtime/palace-evidence-20261012/catalog.json',root),'utf8'));
const live=process.argv.includes('--live');let points;
if(live){const r=await fetch('http://127.0.0.1:8791/cluster-places?west=116.38&south=39.91&east=116.40&north=39.93',{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Catalog unavailable');points=(await r.json()).items;}
else points=original.items.map(p=>{
  const edge=batch.relations.find(r=>r.childId===p.id);const facts=Object.fromEntries(batch.facts.filter(f=>f.placeId===p.id).map(f=>[f.field,{value:f.value,status:'evidence_reviewed',evidence:f.evidence}]));
  return {...p,facts,...(edge?{parentId:edge.parentId,parentRelation:{status:'evidence_reviewed',evidence:edge.evidence}}:{})};
});
const grouped=groupScenicEntities(points),palace=grouped.find(p=>p.sourceRecords?.some(r=>r.id==='osm:relation/9511883'));
assert.ok(palace);assert.equal(palace.children.length,5);
assert.deepEqual(new Set(palace.children.map(c=>c.id)),new Set(batch.relations.map(r=>r.childId)));
for(const child of palace.children){assert.equal(child.groupingEvidence,'official_source_reviewed');assert.equal(child.facts?.openingHours?.value??null,null);}
assert.equal(palace.facts.openingHours.value,batch.facts.find(f=>f.field==='openingHours').value);
for(const name of ['景山公园','北海公园'])assert.ok(grouped.some(p=>p.name===name));
assert.equal(new Set(grouped.flatMap(p=>[...p.sourceRecords,...p.children.flatMap(c=>c.sourceRecords)].map(r=>r.id))).size,original.items.length);
const report={at:new Date().toISOString(),mode:live?'live_cloud_reader':'local_reviewed_batch_preview',cloudWritten:live,checksPassed:7,
  root:{id:palace.id,name:palace.name,children:palace.children.map(c=>({id:c.id,name:c.name,evidence:c.groupingEvidence}))},
  sourceRecordsPreserved:original.items.length,nearbyIndependentPlacesPreserved:2,childOpeningHoursNotCopied:true};
await writeFile(new URL('validation/palace-grouping-'+(live?'live':'preview')+'-20261012.json',root),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
