// Read-only, bounded API audit. No database credentials, paid providers or UI.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const base=new URL(process.env.PLACE_AUDIT_BASE || 'http://127.0.0.1:8787');
if(!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.username||base.password)throw Error('Audit base must be a credential-free loopback URL');
const output=path.resolve(process.argv[2] || 'validation/place-data-audit-20261011.json');
const areas=[{name:'苏州中心周边',lat:31.316,lng:120.619},{name:'上海中心周边',lat:31.23,lng:121.47},{name:'东京中心周边',lat:35.68,lng:139.76}];
const categories=['scenic','accommodation','transport','rest'];
const fields=['id','name','aliases','category','subcategory','lat','lng','coord_system','coordinate_role','source','source_url','license','source_timestamp','facts','missingFields'];
const factNames=['openingHours','lastEntry','reservation','ticketPrice','stayMinutes','fee','website','phone','wheelchair','checkIn','checkOut','address','access'];
const hasValue=f=>f && f.status!=='unknown' && f.value!==null && f.value!==undefined && f.value!=='';
async function read(api){
  const start=performance.now(),r=await fetch(new URL(api,base),{signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error(`HTTP ${r.status}`);
  return {data:await r.json(),httpMs:Math.round((performance.now()-start)*100)/100};
}
const report={at:new Date().toISOString(),scope:'purposive bounded sample; not a random or population-wide completeness estimate',
  databaseWrites:false,paidProviderRequests:0,parameters:{areas,categories,radiusM:5000,limitPerQuery:15},queries:[],failures:[]};
report.coverage=(await read('/api/catalog/coverage')).data;
const unique=new Map();
for(const area of areas)for(const category of categories){
  const params=new URLSearchParams({lat:String(area.lat),lng:String(area.lng),radius:'5000',category,limit:'15'});
  try{
    const {data,httpMs}=await read('/api/catalog/search?'+params),items=data.items || [];
    report.queries.push({area:area.name,category,status:data.status,count:items.length,hasMore:data.hasMore,httpMs,serviceMs:data.elapsedMs,
      presentFacts:Object.fromEntries(factNames.map(f=>[f,items.filter(p=>hasValue(p.facts?.[f])).length])),
      missingRequiredKeys:items.flatMap(p=>fields.filter(k=>!Object.hasOwn(p,k)).map(key=>({id:p.id,key}))),
      example:items[0] || null});
    for(const p of items)unique.set(p.id,p);
  }catch(e){report.failures.push({area:area.name,category,error:e.message});}
}
const items=[...unique.values()];
report.sample={uniqueRecords:items.length,liveQueries:report.queries.filter(q=>q.status==='live').length,
  structuralMissingKeys:report.queries.flatMap(q=>q.missingRequiredKeys),
  geography:Object.fromEntries(['country','province','city','timezone'].map(k=>[k,items.filter(p=>p[k]).length])),
  coordinates:Object.fromEntries([...new Set(items.map(p=>p.coordinate_role))].map(k=>[k,items.filter(p=>p.coordinate_role===k).length])),
  presentFacts:Object.fromEntries(factNames.map(k=>[k,items.filter(p=>hasValue(p.facts?.[k])).length])),
  factsWithValidity:items.reduce((n,p)=>n+Object.values(p.facts || {}).filter(f=>hasValue(f)&&(f.validFrom||f.validThrough||f.validTo)).length,0),
  factsWithValues:items.reduce((n,p)=>n+Object.values(p.facts || {}).filter(hasValue).length,0)};
report.limitations=['只抽查三座城市中心 5 公里内、每类前 15 条；排序和区域偏差明确存在。','空值不等于地点不存在该服务。','原始标签保存在服务器，HTTP 未输出的字段不能在本次审计中视为原库不存在。','未测试商业地图、未抽取全库、未修改远程数据库。'];
await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,rows:report.coverage.rows,queries:report.queries.length,failures:report.failures,sample:report.sample},null,2));
if(report.failures.length)process.exitCode=1;
