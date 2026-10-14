// This is the reviewed 2026-10-12 pilot, not an automatic semantic approval policy.
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateScenicEnrichment} from '../server/services/scenic-enrichment.mjs';
const root=new URL('../',import.meta.url),dir=new URL('.runtime/palace-evidence-20261012/',root);
const inputs=JSON.parse(await readFile(new URL('inputs.json',dir),'utf8'));
const draft=JSON.parse(await readFile(new URL('draft.json',dir),'utf8'));
const now=new Date().toISOString(),changes=[],out={version:1,batchId:'palace-20261012',relations:[],facts:[],unresolved:[],sources:[]};
for(const input of inputs){
  const call=draft.calls.find(c=>c.job===input.key);
  const {scenicEnrichmentInstruction}=await import('../server/services/scenic-enrichment.mjs');
  const hash=createHash('sha256').update(JSON.stringify({instruction:scenicEnrichmentInstruction,input,model:draft.model})).digest('hex');
  const result=JSON.parse(await readFile(new URL(input.key+'-'+hash.slice(0,16)+'.json',dir),'utf8'));
  const response=structuredClone(result.output);
  if(!response.facts){response.facts=[];changes.push({job:input.key,field:'facts',reason:'补齐本任务不请求的空数组；未新增事实'});}
  for(const row of [...response.relations,...response.facts]){
    const source=input.evidence.find(e=>e.id===row.evidenceId);
    let quote=row.quote;
    if(row.evidenceId==='palace-guide')quote=source.text;
    if(row.field==='openingHours'||row.field==='lastEntry')quote=source.text;
    if(row.field==='ticketPrice')quote=source.text.slice(0,source.text.indexOf('（3）')).trim();
    if(row.field==='reservation')quote=source.text.slice(source.text.indexOf('1、'),source.text.indexOf('3、')).trim();
    if(row.field==='description'&&row.evidenceId==='taihe-history')quote=source.text.split('\n').slice(0,2).join('\n');
    if(quote!==row.quote){changes.push({job:input.key,placeId:row.placeId||row.childId,field:row.field||'relation',reason:'原引用未覆盖完整结论，核对后扩展为连续原文',before:row.quote,after:quote});row.quote=quote;}
    if(row.field==='openingHours'){const before=row.value;row.value+='；节假日、重大活动及特殊情况的调整以官方公告为准。';changes.push({job:input.key,field:row.field,reason:'补回官方原文明确的临时调整限制',before,after:row.value});}
    if(row.field==='reservation'){const before=row.value;row.value='所有观众须实名预约；'+row.value;changes.push({job:input.key,field:row.field,reason:'补回当前个人订票须知明确的实名要求',before,after:row.value});}
  }
  const checked=validateScenicEnrichment(response,input,now);
  for(const row of [...checked.relations,...checked.facts]){
    row.verifiedAt=now;
    Object.assign(row.evidence,{reviewStatus:'accepted',reviewMethod:'source_excerpt_review',reviewedBy:'Codex assisted editorial review',
      extractionModel:draft.model,batchId:out.batchId,inputHash:hash,
      uncertainty:'按本次读取的官方栏目核对；未公开发布时间不猜测，不保证余票、实时开放及未列出的临时公告。'});
    if(row.field==='ticketPrice')row.evidence.scope='ordinary_adult_gate_ticket_published_reference_not_live_price';
  }
  for(const key of ['relations','facts','unresolved'])out[key].push(...checked[key]);
  for(const source of input.evidence)if(!out.sources.some(s=>s.id===source.id))out.sources.push(source);
}
const controlIds=inputs[0].places.filter(p=>['景山公园','北海公园'].includes(p.name)).map(p=>p.id);
if(out.relations.length!==5||out.facts.length!==9||out.relations.some(r=>controlIds.includes(r.childId)))throw Error('Unexpected reviewed pilot outcome');
const report={at:now,model:draft.model,actualCalls:4,totalTokens:draft.calls.reduce((n,c)=>n+c.usage.total_tokens,0),relations:out.relations.length,facts:out.facts.length,
  changes,controls:{nearbyIndependentPlacesNotAttached:2},unresolved:out.unresolved,
  sourceIssues:['订票页HTML残留旧疫情提示和旧票务条款；仅采用明确的个人订票须知与一致的大门票价格。',
    '官网栏目没有可靠发布时间；sourceTimestamp保持null，抓取时间单独保存。',
    '乾清宫、御花园归属由官方导览结构核对；本批没有独立开放规则和游览时长证据。'],cloudWritten:false};
await mkdir(new URL('data/editorial/',root),{recursive:true});
await writeFile(new URL('data/editorial/palace-20261012.json',root),JSON.stringify(out,null,2)+'\n');
await writeFile(new URL('validation/palace-enrichment-20261012.json',root),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({relations:out.relations.length,facts:out.facts.length,reviewChanges:changes.length,totalTokens:report.totalTokens,cloudWritten:false}));
