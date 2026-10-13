// Read-only database acceptance; performs no provider HTTP requests.
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const local=JSON.parse(await readFile(new URL('.runtime/local.json',root),'utf8'));
process.env.DATABASE_URL=`postgresql://seatraces:${encodeURIComponent(local.password)}@127.0.0.1:${local.port}/seatraces`;
process.env.AMAP_PARENT_LOOKUP_ENABLED='false';
const {pool,query}=await import('../server/db.mjs');
try {
  const {currentParentHierarchy}=await import('../server/services/scenic-parents.mjs');
  const {clusterScenicPlaces}=await import('../server/domain/scenic-clusters.mjs');
  const {representedIds}=await import('../server/domain/scenic-entities.mjs');
  const data=JSON.parse(await readFile(new URL('.runtime/scenic-hierarchy/geometry-result.json',root),'utf8'));
  const cities=[];
  for(const cityId of data.cities) {
    const points=data.points.filter(p=>p.cityId===cityId).map(p=>({...p,mainlandCityVerified:true}));
    const hierarchy=await currentParentHierarchy(points);
    const clusters=clusterScenicPlaces(hierarchy.places);
    const ids=new Set(clusters.flatMap(c=>c.members.flatMap(representedIds)));
    const missing=points.filter(p=>!ids.has(p.id)).map(p=>p.id);
    cities.push({id:cityId,total:points.length,clusters:clusters.length,missingOriginalIds:missing,
      selectablePlaces:clusters.reduce((n,c)=>n+c.members.length,0),
      children:clusters.reduce((n,c)=>n+c.childCount,0),
      modelGroupedChildren:clusters.flatMap(c=>c.members.flatMap(p=>p.children||[])).filter(p=>p.groupingReviewNeeded).length,
      modelOverlayCount:hierarchy.coverage.modelSuggestedChildren,
      modelExamples:clusters.flatMap(c=>c.members.flatMap(p=>(p.children||[]).filter(q=>q.groupingReviewNeeded).map(q=>({parent:p.name,child:q.name})))).slice(0,5),
      supplementalChildren:hierarchy.places.filter(p=>p.parentRelation?.method==='official_evidence_review').map(p=>({name:p.name,parentId:p.parentId}))});
  }
  const report={at:new Date().toISOString(),cities,
    storedResults:(await query('SELECT count(*)::int n FROM scenic_hierarchy_results')).rows[0].n,
    storedPolygons:(await query('SELECT count(*)::int n FROM scenic_area_geometries')).rows[0].n,
    statuses:(await query("SELECT result->>'status' status,count(*)::int n FROM scenic_hierarchy_results GROUP BY 1")).rows,
    amapParentCalls:(await query("SELECT count(*)::int n FROM api_usage WHERE provider='AmapParent'")).rows[0].n,
    activeWorkers:(await query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND classid=20261012 AND objid IN (1,2) AND granted")).rows[0].n};
  report.passed=report.storedResults===data.points.length && report.storedPolygons===Object.keys(data.geometries).length && cities.every(c=>!c.missingOriginalIds.length);
  await writeFile(new URL('validation/scenic-hierarchy-readback.json',root),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  if(!report.passed)process.exitCode=1;
} catch(error){console.error(JSON.stringify({error:error.code||'verification_failed'}));process.exitCode=1;}
finally{await pool.end();}
