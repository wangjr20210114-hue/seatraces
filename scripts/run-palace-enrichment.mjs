// Bounded official-evidence pilot, budgeted API calls, resumable by exact input hash.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { validateScenicEnrichment, scenicEnrichmentInstruction } from '../server/services/scenic-enrichment.mjs';
const root=new URL('../',import.meta.url), dir=new URL('.runtime/palace-evidence-20261012/',root);
const read=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/\r\n/g,'\n');
const sources=JSON.parse(await read('sources.json'));
const catalog=JSON.parse(await read('catalog.json'));
const wanted=['故宫','太和殿','中和殿','保和殿','乾清宫','御花园','景山公园','北海公园'];
const places=catalog.items.filter(p=>wanted.includes(p.name));
if(places.length!==wanted.length)throw Error('Pilot place set incomplete');
const parentId=places.find(p=>p.name==='故宫').id, childIds=places.filter(p=>['太和殿','中和殿','保和殿','乾清宫','御花园'].includes(p.name)).map(p=>p.id);
function cut(text,start,end){const a=text.indexOf(start),b=text.indexOf(end,a+start.length);if(a<0||b<0)throw Error('Source section changed');return text.slice(a,b).trim();}
async function excerpt(sourceId,id,fields,placeIds,select){const s=sources.find(s=>s.id===sourceId);if(!s)throw Error('Missing source');return {...s,id,fields,placeIds,text:select(await read(s.textFile))};}
const evidence=[
  await excerpt('guide','palace-guide',['relation'],childIds,t=>cut(t,'了解“紫禁城”的新方式','钦安殿')),
  await excerpt('visit','hours',['openingHours','lastEntry'],[parentId],t=>cut(t,'开放时间\n故宫博物院全年开放','导览地图')),
  await excerpt('booking','personal-booking',['reservation','phone','access'],[parentId],t=>cut(t,'个人订票须知','旅行社预约购票、检票须知')),
  await excerpt('booking','adult-price',['ticketPrice'],[parentId],t=>cut(t,'1.门票价格：','2.大门票优惠政策：')),
  await excerpt('taihe','taihe-history',['description','relation'],[places.find(p=>p.name==='太和殿').id],t=>cut(t,'太和殿，俗称','撰稿人：')),
  await excerpt('baohe','baohe-history',['description','relation'],[places.find(p=>p.name==='保和殿').id],t=>cut(t,'保和殿，故宫','撰稿人：')),
  await excerpt('zhonghe','zhonghe-history',['description','relation'],[places.find(p=>p.name==='中和殿').id],t=>cut(t,'中和殿，故宫','撰稿人：')),
];
const jobs=[
  {key:'relationships',task:'识别给定已收录小景点与父景区的关系；附近独立地点不强行归属。另有军机处在官方导览中，但不在本次数据库地点列表，列为待补录。只返回relations与unresolved。',allowedFields:[],evidence:evidence.filter(e=>e.fields.includes('relation'))},
  {key:'opening',task:'只提取父景区开放时间、停止入场时间。只返回facts。',allowedFields:['openingHours','lastEntry'],evidence:evidence.filter(e=>e.id==='hours')},
  {key:'booking',task:'只提取父景区普通成人大门票公布价、预约规则、客服电话号码、入口出口规则。预约摘要保留不售当日票、提前7日20时和年票例外，不抄全部细则。只返回facts。',allowedFields:['ticketPrice','reservation','phone','access'],evidence:evidence.filter(e=>['personal-booking','adult-price'].includes(e.id))},
  {key:'descriptions',task:'只提取有独立建筑介绍证据的内部景点简介，每条不超过60字。只返回facts。',allowedFields:['description'],evidence:evidence.filter(e=>e.fields.includes('description'))},
];
const inputs=jobs.map(j=>({...j,parentId,places}));
await writeFile(new URL('inputs.json',dir),JSON.stringify(inputs,null,2));
if(!process.argv.includes('--live')) {console.log(JSON.stringify({mode:'prepared',jobs:inputs.length,places:places.length,excerpts:evidence.map(e=>({id:e.id,chars:e.text.length}))}));process.exit(0);}
dotenv.config({path:new URL('.env',root),quiet:true});
const cfg=JSON.parse(await readFile(new URL('.runtime/local.json',root),'utf8'));
process.env.DATABASE_URL=`postgresql://seatraces:${encodeURIComponent(cfg.password)}@127.0.0.1:${cfg.port}/seatraces`;
const {pool}=await import('../server/db.mjs');
const {request}=await import('../server/integrations/http.mjs');
const {createDeepseekClient}=await import('../server/integrations/deepseek.mjs');
let lastUsage;
const llm=createDeepseekClient({requestJSON:async(...args)=>{const r=await request(...args);lastUsage=r.usage;return r;}});
const report={batchId:'palace-20261012',at:new Date().toISOString(),model:process.env.DEEPSEEK_MODEL||'deepseek-flash',calls:[],relations:[],facts:[],unresolved:[],rejectedJobs:[],reviewStatus:'pending'};
try {
  for(const input of inputs){
    const hash=createHash('sha256').update(JSON.stringify({instruction:scenicEnrichmentInstruction,input,model:report.model})).digest('hex');
    const checkpoint=new URL(input.key+'-'+hash.slice(0,16)+'.json',dir);let result, cached=false;
    try{result=JSON.parse(await readFile(checkpoint,'utf8'));cached=true;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!result){const started=Date.now();lastUsage=null;const output=await llm(scenicEnrichmentInstruction,input,{maxTokens:1800});result={hash,output,usage:lastUsage,elapsedMs:Date.now()-started};await writeFile(checkpoint,JSON.stringify(result,null,2));}
    let validated;
    try {validated=validateScenicEnrichment(result.output,input);}
    catch(error){report.rejectedJobs.push({job:input.key,inputHash:hash,checkpoint:new URL(checkpoint).pathname,reason:error.issues?.map(i=>({path:i.path,code:i.code}))||error.message});report.calls.push({job:input.key,cached,usage:result.usage,elapsedMs:result.elapsedMs,validation:'rejected'});console.log(JSON.stringify({job:input.key,validation:'rejected',cached}));await writeFile(new URL('draft.json',dir),JSON.stringify(report,null,2));continue;}
    for(const row of [...validated.relations,...validated.facts])Object.assign(row.evidence,{extractionModel:report.model,batchId:report.batchId,inputHash:hash});
    for(const key of ['relations','facts','unresolved'])report[key].push(...validated[key]);
    const call={job:input.key,cached,usage:result.usage,elapsedMs:result.elapsedMs,relations:validated.relations.length,facts:validated.facts.length};report.calls.push(call);console.log(JSON.stringify(call));
    await writeFile(new URL('draft.json',dir),JSON.stringify(report,null,2));
  }
} finally {await pool.end();}
