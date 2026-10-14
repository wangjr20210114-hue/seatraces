import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const base=process.env.TEST_URL||'http://127.0.0.1:8787';
const report={at:new Date().toISOString(),scope:'Full cloud OSM via authorized private connection and application HTTP API; warm queries; excludes commercial provider calls.',checks:[],samples:{},timings:{}};
let cookie='';
async function request(path,body){
  const start=performance.now(),r=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Seatraces':'1',Cookie:cookie},body:body?JSON.stringify(body):undefined});
  if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
  return {status:r.status,data:await r.json(),httpMs:Math.round((performance.now()-start)*100)/100};
}
async function check(name,fn){try{const detail=await fn();report.checks.push({name,passed:true,detail});}catch(e){report.checks.push({name,passed:false,error:e.message});}}
async function search(params){const r=await request('/catalog/search?'+new URLSearchParams(params));assert.equal(r.status,200);assert.equal(r.data.status,'live');return r;}
await check('coverage',async()=>{const r=await request('/catalog/coverage');assert.equal(r.data.regions.length,8);assert.equal(r.data.rows,4567502);return r.data;});
for(const [name,params,expected] of [
  ['tokyo_simplified',{q:'东京塔'},'osm:relation/4247312'],
  ['tokyo_english',{q:'Tokyo Tower'},'osm:relation/4247312'],
  ['bund',{q:'外滩',region:'china'}],
  ['taipei',{q:'台北101',region:'taiwan'}],
  ['palace',{q:'경복궁',region:'south-korea'}],
  ['hostels',{q:'',category:'accommodation',subcategory:'hostel',lng:139.7454,lat:35.6586,radius:10000}],
  ['shanghai_scenic',{q:'',category:'scenic',lng:121.49,lat:31.24,radius:3000}]
])await check(name,async()=>{const r=await search(params);assert.ok(r.data.items.length);if(expected)assert.equal(r.data.items[0].id,expected);
  assert.equal(new Set(r.data.items.map(p=>p.id)).size,r.data.items.length);
  if(params.category==='scenic')assert.ok(r.data.items.every(p=>['attraction','heritage','nature','leisure'].includes(p.category)));
  if(params.subcategory)assert.ok(r.data.items.every(p=>p.subcategory===params.subcategory));
  if(params.radius)assert.ok(r.data.items.every(p=>p.distance_m<=params.radius));
  report.samples[name]=r.data.items.slice(0,3);return {count:r.data.items.length,httpMs:r.httpMs,serviceMs:r.data.elapsedMs,first:r.data.items[0].id};});
await check('detail_source_and_unknowns',async()=>{const r=await request('/catalog/place?id='+encodeURIComponent('osm:relation/4247312'));assert.equal(r.status,200);assert.equal(r.data.facts.ticketPrice.value,null);assert.equal(r.data.facts.ticketPrice.status,'unknown');assert.equal(r.data.coord_system,'WGS84');assert.ok(r.data.source_url.startsWith('https://www.openstreetmap.org/'));assert.match(r.data.facts.lastEntry.value,/22:30/);assert.equal(r.data.facts.lastEntry.sourceUrl,'https://en.tokyotower.co.jp/');return {name:r.data.name,openingHours:r.data.facts.openingHours,lastEntry:r.data.facts.lastEntry,coordinateRole:r.data.coordinate_role};});
for(const params of [{q:'湖'},{q:'x'.repeat(121)},{q:'外滩',lat:31},{q:'外滩',lat:'NaN',lng:121},{q:'外滩',limit:61}])await check('reject_'+JSON.stringify(params).slice(0,45),async()=>{assert.equal((await request('/catalog/search?'+new URLSearchParams(params))).status,400);});
await check('literal_SQL_shaped_query',async()=>{const r=await search({q:"_%' OR true --"});assert.equal(r.data.items.length,0);});
await check('provider_unavailable_is_explicit',async()=>{await request('/auth/demo',{});const r=await request('/routes',{from:'osm:relation/4247312',to:report.samples.hostels[0].id,mode:'transit'});assert.equal(r.status,200);assert.equal(r.data.status,'estimated');assert.equal(r.data.reason,'coverage_unavailable');return {status:r.data.status,reason:r.data.reason};});
for(const [label,params] of [['东京塔',{q:'东京塔'}],['外滩',{q:'外滩'}],['上海附近景点',{q:'',category:'scenic',lng:121.49,lat:31.24,radius:3000}]]){
  const times=[],server=[];
  for(let i=0;i<5;i++){const r=await search(params);times.push(r.httpMs);server.push(r.data.elapsedMs);}
  times.sort((a,b)=>a-b);server.sort((a,b)=>a-b);
  report.timings[label]={samples:5,httpMedianMs:times[2],httpMaxMs:times[4],serviceMedianMs:server[2],serviceMaxMs:server[4]};
}
report.passed=report.checks.filter(x=>x.passed).length;report.failed=report.checks.length-report.passed;
await writeFile(process.env.CATALOG_REPORT_PATH||'validation/catalog-live-20261011.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,failed:report.failed,failures:report.checks.filter(x=>!x.passed),timings:report.timings},null,2));
process.exitCode=report.failed?1:0;
