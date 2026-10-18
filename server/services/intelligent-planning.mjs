import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {alternativeInput,makeDayAlternatives,verifyDayAlternative} from '../domain/day-alternatives.mjs';
import {openingOnDate} from '../opening-hours.mjs';
import {planningPools} from '../repositories/journey-candidates.mjs';
import {matchPlace} from './place-matching.mjs';
import {route} from './routes.mjs';
import {distance} from '../planner.mjs';
import {tripPreferences} from '../agent/travel-language.mjs';
const fail=(s,status=400)=>Object.assign(Error(s),{status});
const publicVariant=(id,v,version)=>({id,name:v.name,focus:v.focus,metrics:v.metrics,verification:v.verification,warnings:v.warnings||[],
 explanations:v.explanations,excluded:v.excluded,unmet:v.unmet,version,stops:v.day.stops.map(p=>({id:p.id,name:p.name,arrive:p.arrive,leave:p.leave}))});
export async function scopedPlanningCandidates(query,trip,userId,target=trip.plan.days[0]){
 const current=target.stops||[],places=(await query("SELECT id,name,lat,lng,category,city,tags,left(description,1600) description,duration_min,source,source_url FROM places WHERE city=$1 AND category IN ('attraction','heritage','nature','leisure') ORDER BY id LIMIT 60",[target.city])).rows;
 const session=(await query('SELECT id FROM journey_sessions WHERE trip_id=$1 AND user_id=$2 ORDER BY updated_at DESC LIMIT 1',[trip.id,userId])).rows[0];
 let catalog=[];
 if(session&&trip.request.selections){
  const pools=await planningPools({query,sessionId:session.id,userId,cities:trip.plan.cities.filter(c=>c.id===target.cityId||c.name===target.city),selections:trip.request.selections,wishes:{}});
  catalog=Object.values(pools).flat();
 }
 return [...new Map([...current,...catalog,...places].filter(p=>p?.id).map(p=>[p.id,p])).values()].slice(0,120);
}
export function parseLocalEdit(text,day){
 const complex=/保留|其余|重排|重新安排|太累|太赶|少安排|少一个|少一处|下午.*(?:累|少)|换个附近|换一个附近|不想去|点前|点之前/.test(text);
 if(!complex)return null;
 const input={keepIds:[],avoidIds:[],...(/下午/.test(text)?{afternoonOnly:true}:{})},stops=day.stops||[];
 const keep=text.match(/保留\s*([^，。；,;]+)/)?.[1]?.split(/其余|其他|剩下/)[0].trim();
 if(keep){
  for(const name of keep.split(/[和、]/).map(s=>s.trim()).filter(Boolean)){
   const matches=stops.filter(p=>[p.name,...(p.aliases||[])].includes(name));
   if(matches.length!==1)return {clarify:'要保留当天哪个地点？',choices:stops.map(p=>({id:p.id,label:p.name,text:text.replace(keep,p.name)}))};
   input.keepIds.push(matches[0].id);
  }
 }
 if(/少安排|少一个|少一处|太累|太赶/.test(text)){input.removeCount=1;input.focus='walk';}
 const end=tripPreferences(text).values.endBy;if(end)input.endBy=end;
 if(/换|不想去/.test(text)){
  let matches=stops.filter(p=>[p.name,...(p.aliases||[])].some(n=>text.includes(n))&&!input.keepIds.includes(p.id));
  if(!matches.length&&/这个博物馆|这家博物馆/.test(text))matches=stops.filter(p=>p.traits?.tourism==='museum'||/博物馆/.test(p.name));
  if(matches.length!==1)return {clarify:'想换掉当天哪个地点？',choices:(matches.length?matches:stops).map(p=>({id:p.id,label:p.name,text:`${text.slice(0,350)}，替换目标：${p.name}`}))};
  input.replaceId=matches[0].id;delete input.removeCount;
 }
 return {input};
}
export function createIntelligentPlanning({query,transaction,loadCandidates=scopedPlanningCandidates,opening=openingOnDate,routeLeg}={}){
 const verifying=new Map();
 async function own(id,userId,c={query}){const t=(await c.query('SELECT * FROM trips WHERE id=$1 AND user_id=$2',[z.uuid().parse(id),userId])).rows[0];if(!t)throw fail('行程不存在',404);if(t.plan.schemaVersion!=='journey/2')throw fail('请在新版行程中比较方案',409);return t;}
 async function compare(id,userId,input,version){
  const trip=await own(id,userId);if(trip.version!==version)throw fail('行程已更新，请刷新后比较',409);
  const b=alternativeInput.parse(input),day=trip.plan.days[b.day];if(!day)throw fail('旅行日期不存在',404);
  const candidates=(await loadCandidates(query,trip,userId,day)).filter(p=>p.city===day.city||day.stops.some(x=>x.id===p.id)).slice(0,120);
  const result=await makeDayAlternatives(trip,candidates,b,{opening}),items=[];
  await transaction(async c=>{
   await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
   await c.query('DELETE FROM trip_plan_previews WHERE user_id=$1 AND (expires_at<=now() OR id IN(SELECT id FROM trip_plan_previews WHERE user_id=$1 ORDER BY created_at DESC,id DESC OFFSET 5))',[userId]);
   for(const v of result.variants){const raw=JSON.stringify(v);if(Buffer.byteLength(raw)>512000)throw fail('预览资料过大，请缩小范围',413);
    const pid=randomUUID();await c.query('INSERT INTO trip_plan_previews(id,user_id,trip_id,base_version,day_index,payload) VALUES($1,$2,$3,$4,$5,$6)',[pid,userId,trip.id,trip.version,b.day,raw]);items.push(publicVariant(pid,v,trip.version));}
  });return {items,unmet:result.unmet,version:trip.version,candidateCount:result.candidateCount};
 }
 async function preview(id,userId,tripId){const row=(await query('SELECT * FROM trip_plan_previews WHERE id=$1 AND user_id=$2 AND trip_id=$3 AND expires_at>now()',[z.uuid().parse(id),userId,tripId])).rows[0];if(!row)throw fail('预览已过期或不存在，请重新比较',410);return row;}
 async function verifyActual(tripId,userId,pid,version){
  const t=await own(tripId,userId),row=await preview(pid,userId,t.id);if(t.version!==version||row.base_version!==version)throw fail('行程已更新，请重新比较',409);
  if(row.payload.verification==='verified')return publicVariant(row.id,row.payload,t.version);
  const matchCache=new Map();
  const resolve=async p=>{if(!matchCache.has(p.id))matchCache.set(p.id,(async()=>{const r=await matchPlace(p);return r.items?.find(x=>x.nameScore>=.75&&x.distanceMeters<=1000&&x.routing)?.routing;})());return matchCache.get(p.id);};
  const leg=routeLeg||(async(a,b,date,time,strategy)=>{
   const from=await resolve(a),to=await resolve(b);if(!from||!to)return {status:'unresolved'};
   const mode=distance(a,b)<=1.2&&!(strategy==='fewWalking'&&distance(a,b)>.4)?'walking':'transit';
   const r=await route(a,b,strategy,mode,date+'T'+time,t.plan.days[row.day_index].timezone,{from,to}),choice=r.status==='live'?r.alternatives?.[0]:null;
   return choice?{status:'live',minutes:choice.minutes,walkingMeters:choice.walkingMeters}:{status:r.status};
  });
  const v=await verifyDayAlternative(row.payload,{opening,routeLeg:leg});
  const saved=await query('UPDATE trip_plan_previews SET payload=$2,version=version+1 WHERE id=$1 AND version=$3 AND expires_at>now() RETURNING id',[row.id,v,row.version]);if(!saved.rowCount)throw fail('预览已变化，请重新核验',409);
  return publicVariant(row.id,v,t.version);
 }
 function verify(tripId,userId,pid,version){
  const key=[userId,tripId,pid,version].join(':');if(verifying.has(key))return verifying.get(key);
  if(verifying.size>=2)throw fail('路线核验繁忙，请稍后重试',429);
  const work=verifyActual(tripId,userId,pid,version).finally(()=>verifying.delete(key));verifying.set(key,work);return work;
 }
 async function apply(c,trip,operation,userId){
  const row=(await c.query('SELECT * FROM trip_plan_previews WHERE id=$1 AND user_id=$2 AND trip_id=$3 AND expires_at>now() FOR UPDATE',[operation.previewId,userId,trip.id])).rows[0];
  if(!row)throw fail('修改预览已过期或不存在',410);
  if(row.base_version!==trip.version||row.day_index!==operation.day||row.applied_version)throw fail('预览版本已变化，请重新比较',409);
  const value=row.payload;if(value.verification!=='verified')throw fail('请先核验实际路线并处理时间冲突',409);
  const before=trip.plan.days[operation.day],after=value.day;
  if(before.stops.some((p,i)=>p.locked&&after.stops[i]?.id!==p.id))throw fail('锁定地点不能被修改',409);
  const plan=structuredClone(trip.plan);plan.days[operation.day]={...after,planningExplanation:{previewId:row.id,name:value.name,metrics:value.metrics,included:value.explanations,excluded:value.excluded,checkedAt:new Date().toISOString()}};
  plan.routeStatus='pending';await c.query('UPDATE trip_plan_previews SET applied_version=$2 WHERE id=$1',[row.id,trip.version+1]);return plan;
 }
 return {own,compare,verify,apply};
}
export function installIntelligentPlanning(app,{auth,query,transaction,...deps}){
 const service=createIntelligentPlanning({query,transaction,...deps});
 app.post('/api/journey/trips/:id/alternatives',auth,async(req,res)=>{const {version,...input}=z.object({version:z.number().int().positive(),...alternativeInput.shape}).strict().parse(req.body);res.json(await service.compare(req.params.id,req.user.id,input,version));});
 app.post('/api/journey/trips/:id/alternatives/:previewId/verify',auth,async(req,res)=>{const b=z.object({version:z.number().int().positive()}).strict().parse(req.body);res.json(await service.verify(req.params.id,req.user.id,req.params.previewId,b.version));});
 // A complex edit uses the same preview and route verification as the page.
 // Ordinary single-point requests continue through the pre-existing handler.
 app.post('/api/trips/:id/assistant',auth,async(req,res,next)=>{
  const b=z.object({text:z.string().trim().min(1).max(500),day:z.number().int().min(0).max(29)}).strict().parse(req.body);
  const t=await service.own(req.params.id,req.user.id),day=t.plan.days[b.day];if(!day)throw fail('旅行日期不存在',404);
  const parsed=parseLocalEdit(b.text,day);if(!parsed)return next();
  if(parsed.clarify)return res.json({status:'clarify',message:parsed.clarify,choices:parsed.choices});
  const input={day:b.day,...parsed.input,focus:parsed.input.focus||'classics'},r=await service.compare(t.id,req.user.id,input,t.version);
  if(!r.items.length)return res.json({status:'clarify',message:r.unmet.join('；')});
  const v=await service.verify(t.id,req.user.id,r.items[0].id,t.version);
  if(v.verification!=='verified')return res.json({status:'retry',message:(v.warnings||[]).join('；')||'路线暂不可核验，请稍后重试'});
  res.json({status:'preview',source:'内部约束规划',version:t.version,operation:{type:'apply_preview',day:b.day,previewId:v.id},summary:v,message:'已校验修改预览，确认后保存新版本'});
 });
 return service;
}
