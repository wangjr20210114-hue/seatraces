import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {llmJSON} from '../integrations/deepseek.mjs';
import {validateExtractedFacts,extractionInstruction} from './evidence-extraction.mjs';
import {applyFactValidity} from '../domain/fact-validity.mjs';
import {requireManagement} from '../operations/permissions.mjs';
const allowedHosts=new Set(['ylj.suzhou.gov.cn','www.szmuseum.com','www.dpm.org.cn']);
const fail=(s,status=400)=>Object.assign(Error(s),{status});
const hash=s=>createHash('sha256').update(s).digest('hex');
export function officialSourceURL(value){const u=new URL(value);if(u.protocol!=='https:'||!allowedHosts.has(u.hostname)||u.username||u.password||u.port||u.search||u.hash)throw fail('仅可使用预登记的官方 HTTPS 页面');return u.href;}
export function officialText(html){return html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<!--[\s\S]*?-->/g,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim().slice(0,24000);}
export async function fetchOfficialPage(url,{fetchImpl=fetch}={}){
 const response=await fetchImpl(officialSourceURL(url),{redirect:'error',signal:AbortSignal.timeout(15000),headers:{'User-Agent':'SeaTraces/1.0 official travel information refresh'}});
 if(!response.ok||!response.headers.get('content-type')?.includes('text/html'))throw fail('官方页面暂不可读取',502);
 const reader=response.body.getReader(),parts=[];let size=0;try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>512000)throw fail('官方页面超过读取上限',413);parts.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
 const raw=Buffer.concat(parts),text=officialText(raw.toString('utf8'));if(text.length<80)throw fail('页面正文不足，请人工核对',502);
 return {text,sha256:hash(raw)};
}
export async function seedOfficialSources(query){
 const data=JSON.parse(await readFile(new URL('../../data/editorial/official-three-20261011.json',import.meta.url),'utf8'));
 const names={'osm:way/468359738':'拙政园','osm:way/420034522':'留园','osm:way/542534202':'苏州博物馆'},groups=new Map();
 for(const f of data.facts){const key=hash(f.placeId+'|'+f.sourceUrl).slice(0,32);if(!groups.has(key))groups.set(key,{...f,fields:[]});groups.get(key).fields.push(f.field);}
 for(const [id,r]of groups)await query('INSERT INTO official_place_sources(id,place_id,place_name,publisher,url,fields) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',[id,r.placeId,names[r.placeId],r.sourceName,officialSourceURL(r.sourceUrl),JSON.stringify([...new Set(r.fields)])]);
 await query("INSERT INTO official_place_sources(id,place_id,place_name,publisher,url,fields) VALUES('palace-visit','osm:relation/9511883','故宫','故宫博物院','https://www.dpm.org.cn/Visit.html','[\"openingHours\",\"lastEntry\",\"ticketPrice\",\"reservation\",\"phone\"]') ON CONFLICT(id) DO NOTHING");
}
export function createOfficialFacts({query,transaction,fetchPage=fetchOfficialPage,model=llmJSON,enabled=()=>Boolean(process.env.DEEPSEEK_API_KEY)}){
 async function overlayMany(places,date){
  if(!places.length)return [];
  const ids=[...new Set(places.map(p=>p.id))];if(ids.length>600)throw fail('资料读取范围过大',413);
  const rows=(await query('SELECT place_id,field,fact FROM official_place_facts WHERE place_id=ANY($1)',[ids])).rows,map=new Map();
  for(const r of rows){if(!map.has(r.place_id))map.set(r.place_id,{});map.get(r.place_id)[r.field]=r.fact;}
  return places.map(p=>applyFactValidity({...p,facts:{...p.facts,...map.get(p.id)}},date));
 }
 async function demand(ids){const unique=[...new Set(ids)].filter(x=>typeof x==='string'&&x.length<=80).slice(0,120);if(unique.length)await query('INSERT INTO place_fact_demand(place_id) SELECT unnest($1::text[]) ON CONFLICT(place_id) DO UPDATE SET uses=place_fact_demand.uses+1,last_requested_at=now()',[unique]);}
 async function refresh({checkpoint=async()=>{}}={}){
  const rows=(await query(`SELECT s.* FROM official_place_sources s LEFT JOIN place_fact_demand d ON d.place_id=s.place_id
   WHERE s.enabled AND (s.refresh_after IS NULL OR s.refresh_after<=now()) ORDER BY d.last_requested_at DESC NULLS LAST,d.uses DESC NULLS LAST,s.id LIMIT 10`)).rows;
  const result={processed:0,unchanged:0,pending:0,failed:0};
  for(const source of rows){await checkpoint({step:'refreshing_official_sources',processed:result.processed,total:rows.length});
   try{
    const page=await fetchPage(source.url);await checkpoint();
    const now=new Date().toISOString(),changed=page.sha256!==source.source_hash;let facts=[];
    if((changed||source.last_status==='model_unavailable')&&enabled())facts=validateExtractedFacts(await model(extractionInstruction,{placeId:source.place_id,name:source.place_name,evidence:[{id:source.id,publisher:source.publisher,url:source.url,text:page.text,sha256:page.sha256,retrievedAt:now,fields:source.fields,scope:'ordinary_published_rules'}]},{maxTokens:1800}),
      {placeId:source.place_id,evidence:[{id:source.id,publisher:source.publisher,url:source.url,text:page.text,sha256:page.sha256,retrievedAt:now,fields:source.fields,scope:'ordinary_published_rules'}]},now);
    await checkpoint();
    await transaction(async c=>{
     const live=(await c.query('SELECT source_hash FROM official_place_sources WHERE id=$1 FOR UPDATE',[source.id])).rows[0];if(live.source_hash!==source.source_hash)throw fail('来源已被其他任务更新',409);
     await c.query("UPDATE official_place_sources SET checked_at=now(),refresh_after=now()+interval '1 day',source_hash=$2,source_text=$3,last_status=$4,version=version+1 WHERE id=$1",[source.id,page.sha256,page.text,changed?(enabled()?'changed':'model_unavailable'):'unchanged']);
     if(changed||facts.length){
      await c.query("UPDATE official_place_facts SET fact=jsonb_set(fact,'{status}','\"needs_review\"'),version=version+1 WHERE source_id=$1",[source.id]);
      await c.query("UPDATE official_fact_reviews SET state='superseded',version=version+1 WHERE source_id=$1 AND state='pending'",[source.id]);
      for(const f of facts)await c.query('INSERT INTO official_fact_reviews(id,source_id,place_id,field,fact) VALUES($1,$2,$3,$4,$5)',[randomUUID(),source.id,source.place_id,f.field,{value:f.value,source:f.sourceName,sourceUrl:f.sourceUrl,verifiedAt:null,status:'needs_review',evidence:f.evidence}]);
     }else{
      const accepted=(await c.query('SELECT field,fact FROM official_place_facts WHERE source_id=$1',[source.id])).rows;
      for(const r of accepted){const fact=r.fact;if(fact.evidence?.reviewStatus!=='accepted'||!page.text.includes(fact.evidence.quote))continue;
       fact.status='evidence_reviewed';fact.verifiedAt=now;fact.evidence.retrievedAt=now;fact.evidence.reviewAfter=new Date(Date.parse(now)+86400000).toISOString();
       await c.query('UPDATE official_place_facts SET fact=$3,version=version+1 WHERE place_id=$1 AND field=$2',[source.place_id,r.field,fact]);}
     }
     await c.query('DELETE FROM place_descriptions WHERE place_id=$1',[source.place_id]);
    });result.processed++;if(!changed)result.unchanged++;result.pending+=facts.length;
   }catch(error){if(['TASK_CANCELLED','LEASE_LOST'].includes(error.code))throw error;result.failed++;await query("UPDATE official_place_sources SET last_status='unavailable',refresh_after=now()+interval '1 hour' WHERE id=$1",[source.id]);}
  }return result;
 }
 async function schedule(){
  if(process.env.OFFICIAL_FACT_AUTO_REFRESH!=='true')return;
  await transaction(async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('seatraces.maintenance-create',0))");
   if((await c.query("SELECT 1 FROM maintenance_tasks WHERE kind='place_refresh' AND state IN ('queued','running')")).rowCount)return;
   if(!(await c.query("SELECT 1 FROM official_place_sources s JOIN place_fact_demand d ON d.place_id=s.place_id WHERE s.enabled AND d.last_requested_at>now()-interval '7 days' AND (s.refresh_after IS NULL OR s.refresh_after<=now()) LIMIT 1")).rowCount)return;
   await c.query("INSERT INTO maintenance_tasks(id,kind) VALUES($1,'place_refresh')",[randomUUID()]);
  });
 }
 let timer;return {overlayMany,overlay:async(p,date)=>(await overlayMany([p],date))[0],demand,refresh,
  schedule,start(){if(process.env.OFFICIAL_FACT_AUTO_REFRESH==='true'&&!timer){timer=setInterval(()=>void schedule().catch(()=>{}),3600000);timer.unref();void schedule().catch(()=>{});}},stop(){clearInterval(timer);timer=null;}};
}
export function installOfficialFactRoutes(app,{query,transaction,events}){
 const audit=async(req,action,id,c)=>events.append({userId:req.user.id,kind:'admin',action,resourceId:id,requestId:req.operationRequestId},c);
 app.get('/api/admin/places/fact-sources',requireManagement,async(req,res)=>{
  res.json({items:(await query(`SELECT s.id,s.place_id,s.place_name,s.publisher,s.url,s.fields,s.checked_at,s.refresh_after,s.last_status,s.version,d.last_requested_at,d.uses,
   (SELECT count(*)::int FROM official_fact_reviews r WHERE r.source_id=s.id AND r.state='pending') pending FROM official_place_sources s LEFT JOIN place_fact_demand d ON d.place_id=s.place_id ORDER BY s.place_name,s.id LIMIT 100`)).rows});
 });
 app.get('/api/admin/places/fact-reviews',requireManagement,async(req,res)=>{const state=z.enum(['pending','accepted','rejected','superseded']).default('pending').parse(req.query.state);
  res.json({items:(await query('SELECT r.*,s.place_name,s.publisher,s.url,s.source_hash,s.source_text FROM official_fact_reviews r JOIN official_place_sources s ON s.id=r.source_id WHERE r.state=$1 ORDER BY r.created_at,r.id LIMIT 30',[state])).rows});});
 app.post('/api/admin/places/fact-reviews/:id',requireManagement,async(req,res)=>{
  const id=z.uuid().parse(req.params.id),b=z.object({version:z.number().int().positive(),decision:z.enum(['accept','reject']),confirmation:z.literal('review-official-fact')}).strict().parse(req.body);
  const r=await transaction(async c=>{
   const row=(await c.query('SELECT * FROM official_fact_reviews WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw fail('资料不存在',404);if(row.version!==b.version||row.state!=='pending')throw fail('复核状态已更新',409);
   if(b.decision==='accept'){
    const source=(await c.query('SELECT * FROM official_place_sources WHERE id=$1 FOR UPDATE',[row.source_id])).rows[0],fact=row.fact;
    if(source.source_hash!==fact.evidence.sourceHash||!source.source_text?.includes(fact.evidence.quote)||Date.parse(fact.evidence.reviewAfter)<=Date.now())throw fail('证据已变化或过期，请重新采集',409);
    fact.status='evidence_reviewed';fact.verifiedAt=new Date().toISOString();fact.evidence.reviewStatus='accepted';fact.evidence.reviewMethod='administrator_source_review';
    await c.query('INSERT INTO official_place_facts(place_id,field,source_id,fact) VALUES($1,$2,$3,$4) ON CONFLICT(place_id,field) DO UPDATE SET source_id=excluded.source_id,fact=excluded.fact,version=official_place_facts.version+1',[row.place_id,row.field,row.source_id,fact]);
    await c.query('DELETE FROM place_descriptions WHERE place_id=$1',[row.place_id]);
   }
   const updated=(await c.query('UPDATE official_fact_reviews SET state=$2,reviewed_at=now(),reviewed_by=$3,version=version+1 WHERE id=$1 RETURNING id,state,version',[id,b.decision==='accept'?'accepted':'rejected',req.user.id])).rows[0];await audit(req,'place.fact_'+b.decision,id,c);return updated;
  });res.json(r);
 });
}
