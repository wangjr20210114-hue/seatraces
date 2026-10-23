/* 检查五座城市的景区主体核验结果。 */

import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
const local=JSON.parse(await readFile(new URL('.runtime/local.json',root),'utf8'));
process.env.DATABASE_URL=`postgresql://seatraces:${encodeURIComponent(local.password)}@127.0.0.1:${local.port}/seatraces`;
const {pool,query}=await import('../server/db.mjs');
const {currentParentHierarchy}=await import('../server/services/scenic-parents.mjs');
const {clusterScenicPlaces}=await import('../server/domain/scenic-clusters.mjs');
const {representedIds,clusterInventory}=await import('../server/domain/scenic-entities.mjs');
const report={at:new Date().toISOString(),cities:[]};
try {
  for(const id of ['beijing','shanghai','gn-1809858','gn-1795565','hangzhou']) {
    const data=JSON.parse(await readFile(new URL('.runtime/five-city-parents/'+id+'.json',root),'utf8'));
    const points=data.places.map(p=>({...p,mainlandCityVerified:data.city.country==='CN' && data.coverage.scope==='city_boundary'}));
    const current=await currentParentHierarchy(points),clusters=clusterScenicPlaces(current.places);
    const ids=new Set(clusters.flatMap(c=>c.members.flatMap(representedIds)));
    const missing=points.filter(p=>!ids.has(p.id));
    assert.equal(missing.length,0,'Lost source records in '+data.city.name);
    for(const p of clusters.flatMap(c=>c.members)) {
      assert.equal(p.hierarchyLevel,1);
      for(const child of p.children){assert.equal(child.hierarchyLevel,2);assert.equal(child.parentId,p.id);}
    }
    report.cities.push({id,name:data.city.name,...current.coverage,inventory:clusterInventory(clusters),allSourceIdsPreserved:true});
  }
  report.usage=(await query("SELECT provider,count(*)::int calls,sum(reserved_cny)::float8 reservedCny FROM api_usage WHERE created_at>=date_trunc('month',now()) GROUP BY provider")).rows;
  await writeFile(new URL('validation/five-city-parents-readback.json',root),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {await pool.end();}
