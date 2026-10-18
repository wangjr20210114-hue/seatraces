import {z} from 'zod';
import {distance} from '../planner.mjs';
import {scorePlace,placeTags} from './scenic-clusters.mjs';
import {allowedByCurrentTrip,constrainedBudget,visitDuration,walkingEstimate} from './travel-constraints.mjs';
import {travelAllowance,breakBeforeStop,clockTime} from './day-budget.mjs';
export const alternativeInput=z.object({day:z.number().int().min(0).max(29),
 focus:z.enum(['walk','culture','classics']).optional(),keepIds:z.array(z.string().min(1).max(80)).max(24).default([]),
 avoidIds:z.array(z.string().min(1).max(80)).max(24).default([]),endBy:z.string().regex(/^(?:0[8-9]|1\d|2[0-2]):[0-5]\d$/).optional(),
 removeCount:z.number().int().min(0).max(10).default(0),afternoonOnly:z.boolean().default(false),
 replaceId:z.string().min(1).max(80).optional(),
}).strict();
const minute=s=>typeof s==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s)?Number(s.slice(0,2))*60+Number(s.slice(3,5)):NaN;
export const variantNames={walk:'少走路',culture:'人文深入',classics:'经典覆盖'};
function preferencesFor(focus,base,input){return {...base,...(input.endBy?{endBy:input.endBy}:{}),
 ...(focus==='walk'?{transport:'fewWalking'}:focus==='culture'?{travelFocus:'immersive'}:{travelFocus:'famous'})};}
function ranking(place,previous,focus,prefs){
 const score=scorePlace(place,prefs,place.signals||{}),tags=placeTags(place),near=previous?distance(previous,place):0;
 if(focus==='walk')return score.total/(visitDuration(place,prefs).minutes+30+near*60);
 if(focus==='culture')return score.total+(tags.some(t=>['人文','艺术','建筑'].includes(t))?25:0)-near*2;
 return score.total-near*2;
}
export async function makeDayAlternatives(trip,candidates,input,{opening=async()=>null}={}){
 const b=alternativeInput.parse(input),original=structuredClone(trip.plan.days?.[b.day]);
 if(!original)throw Object.assign(Error('旅行日期不存在'),{status:404});
 if(!Array.isArray(original.stops))throw Object.assign(Error('原行程地点结构不可用，请重新生成'),{status:409});
 if((original.stops||[]).length>24||candidates.length>120)throw Object.assign(Error('候选范围过大，请缩小修改范围'),{status:413});
 for(const p of original.stops){if(!Number.isFinite(p.duration_min)||p.duration_min<=0)p.duration_min=visitDuration(p,trip.request).minutes;
  if(!Number.isFinite(minute(p.leave))&&Number.isFinite(minute(p.arrive)))p.leave=clockTime(minute(p.arrive)+p.duration_min);}
 const current=new Set(original.stops.map(p=>p.id)),elsewhere=new Set(trip.plan.days.flatMap((d,i)=>i===b.day?[]:(d.stops||[]).map(p=>p.id)));
 const all=new Map([...candidates,...original.stops].map(p=>[p.id,p]));
 for(const id of [...b.keepIds,...b.avoidIds,...(b.replaceId?[b.replaceId]:[])])if(!current.has(id))throw Object.assign(Error('保留或移除的地点必须属于当天行程'),{status:400});
 const prefix=[];
 if(b.afternoonOnly)for(const p of original.stops){if(!p.arrive||minute(p.arrive)>=720)break;prefix.push(p);}
 if(b.afternoonOnly&&prefix.length===original.stops.length)return {variants:[],unmet:['当天没有可调整的下午景点'],candidateCount:all.size};
 const mandatory=new Set([...b.keepIds,...original.stops.filter(p=>p.locked||p.wanted&&p.id!==b.replaceId||b.replaceId&&p.id!==b.replaceId).map(p=>p.id),...prefix.map(p=>p.id)]);
 if(b.replaceId&&(mandatory.has(b.replaceId)||original.stops.find(p=>p.id===b.replaceId)?.locked))return {variants:[],unmet:['替换目标被锁定或明确保留，请先调整保留范围'],candidateCount:all.size};
 if(b.avoidIds.some(id=>mandatory.has(id)))return {variants:[],unmet:['要移除的地点被锁定、明确保留或标记想去，请先确认调整范围'],candidateCount:all.size};
 const maxCount=b.replaceId?original.stops.length:b.removeCount?original.stops.length-b.removeCount:24;
 if(maxCount<mandatory.size||maxCount<1||original.stops.some((p,i)=>p.locked&&i>=maxCount))return {variants:[],unmet:['需要保留的地点与减少数量的要求冲突'],candidateCount:all.size};
 const variants=[],seen=new Set();
 for(const focus of b.focus?[b.focus]:Object.keys(variantNames)){
  const prefs=preferencesFor(focus,trip.request,b),budget={...constrainedBudget(prefs,Boolean(original.transferAllowance)),...original.timeBudget};
  if(![budget.start,budget.end,budget.transitionMinutes,budget.mealMinutes].every(x=>Number.isFinite(x)&&x>=0&&x<=1440)||budget.start>=budget.end)throw Object.assign(Error('原行程时间范围不可用，请重新生成'),{status:409});
  if(prefs.endBy)budget.end=Math.min(budget.end,minute(prefs.endBy));budget.availableMinutes=Math.max(0,budget.end-budget.start);
  const stops=structuredClone(prefix),used=new Set(stops.map(p=>p.id)),excluded=[],reasons=[];
  let clock=stops.length?minute(stops.at(-1).leave):budget.start,previous=stops.at(-1)||null,walkKm=0,routeKm=0;
  const allowed=[...all.values()].filter(p=>typeof p.id==='string'&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180&&
    (current.has(p.id)||['attraction','heritage','nature','leisure'].includes(p.category))&&!b.avoidIds.includes(p.id)&&p.id!==b.replaceId&&
    (!b.replaceId||current.has(p.id)||distance(all.get(b.replaceId),p)<=1.2)&&(!elsewhere.has(p.id)||current.has(p.id))&&allowedByCurrentTrip(p,prefs));
  const pending=[...allowed];
  while(pending.length&&stops.length<maxCount){
   const slot=stops.length,locked=original.stops[slot]&&(original.stops[slot].locked||b.replaceId&&original.stops[slot].id!==b.replaceId)?original.stops[slot]:null;
   const required=pending.filter(p=>mandatory.has(p.id)&&!used.has(p.id)&&!original.stops.some((x,i)=>x.id===p.id&&x.locked&&i!==slot));
   const pool=locked?[all.get(locked.id)]:b.replaceId?pending.filter(p=>!current.has(p.id)&&!used.has(p.id)):required.length?required:pending.filter(p=>!used.has(p.id)&&!original.stops.some(x=>x.id===p.id&&x.locked));
   if(!pool.length)break;
   const p=[...pool].sort((a,c)=>ranking(c,previous,focus,prefs)-ranking(a,previous,focus,prefs)||a.id.localeCompare(c.id))[0];
   const ix=pending.findIndex(x=>x.id===p.id);if(ix>=0)pending.splice(ix,1);if(used.has(p.id))continue;
   const visit=p.locked?{minutes:p.duration_min,source:p.durationSource||'retained'}:visitDuration(p,prefs),travel=travelAllowance(previous,p,prefs.transport),pause=breakBeforeStop(stops,clock,budget),walk=walkingEstimate(previous,p,prefs);
   const hours=await opening(p,original.date);let arrive=clock+travel+pause.minutes,reason;
   if(hours?.status==='parsed'&&hours.dayState==='closed')reason='closed';
   const intervals=hours?.status==='parsed'?hours.intervals?.filter(w=>!w.unknown):[];
   if(!reason&&intervals?.length){const fit=intervals.find(w=>Math.max(arrive,minute(w.start))+visit.minutes<=minute(w.end));if(fit)arrive=Math.max(arrive,minute(fit.start));else reason='opening_window';}
   if(!reason&&arrive+visit.minutes>budget.end)reason='time_budget';
   if(!reason&&prefs.walkingLimitKm&&walkKm+walk>prefs.walkingLimitKm)reason='walking_allowance';
   if(reason){excluded.push({id:p.id,name:p.name,reason});if(locked)break;continue;}
   const next={...p,duration_min:visit.minutes,durationSource:visit.source,arrive:clockTime(arrive),leave:clockTime(arrive+visit.minutes),travelMin:travel,breakBeforeMinutes:pause.minutes,mealBefore:pause.meal,timingStatus:'draft',openingStatus:hours?.dayState||'unknown'};
   stops.push(next);used.add(p.id);walkKm+=walk;routeKm+=previous?distance(previous,p)*1.3:0;clock=arrive+visit.minutes;previous=p;
   reasons.push({id:p.id,name:p.name,reason:mandatory.has(p.id)?'explicitly_retained':focus==='walk'?'nearby_less_walking':focus==='culture'?'cultural_interest_and_depth':'popularity_and_coverage'});
  }
  const unmet=[...mandatory].filter(id=>!used.has(id)).map(id=>({id,name:all.get(id)?.name,reason:excluded.find(p=>p.id===id)?.reason||'not_feasible'}));
  if(!stops.length||unmet.length||b.replaceId&&stops.length!==maxCount||original.stops.some((p,i)=>p.locked&&stops[i]?.id!==p.id))continue;
  for(const p of all.values())if(!used.has(p.id)&&!excluded.some(x=>x.id===p.id))excluded.push({id:p.id,name:p.name,reason:b.avoidIds.includes(p.id)||p.id===b.replaceId?'current_exclusion':elsewhere.has(p.id)?'already_scheduled_elsewhere':'strategy_or_capacity'});
  const key=JSON.stringify(stops.map(p=>[p.id,p.duration_min]));if(seen.has(key))continue;seen.add(key);
  variants.push({focus,name:variantNames[focus],day:{...original,stops,timeBudget:budget,routeStatus:'pending'},
   metrics:{walkingMeters:Math.round(walkKm*1000),routeMeters:Math.round(routeKm*1000),routeDistanceStatus:'estimated',travelMinutes:stops.reduce((s,p)=>s+(p.travelMin||0),0),visitMinutes:stops.reduce((s,p)=>s+(p.duration_min||0),0),finishAt:stops.at(-1).leave,status:'estimated',walkingScope:prefix.length?'remaining_legs_excludes_previous_and_internal_walks':'between_places_excludes_internal_walks'},
   explanations:reasons,excluded:excluded.slice(0,120),unmet,verification:'required',constraints:{...b,prefs,frozenPrefixCount:prefix.length}});
 }
 return {variants,unmet:variants.length?[]:['可用时间、开放规则或保留条件之间有冲突，请调整要求'],candidateCount:all.size};
}

export async function verifyDayAlternative(variant,{routeLeg,opening=async()=>null}={}){
 const value=structuredClone(variant),day=value.day,budget=day.timeBudget,prefix=value.constraints.frozenPrefixCount||0,stops=structuredClone(day.stops.slice(0,prefix)),warnings=[];let clock=prefix?minute(stops.at(-1).leave):budget.start,walking=0,travel=0;
 for(let i=prefix;i<day.stops.length;i++){
  const p=day.stops[i],leg=i?await routeLeg(day.stops[i-1],p,day.date,clockTime(clock),value.constraints.prefs.transport):null;
  if(i&&(leg?.status!=='live'||!Number.isFinite(leg.minutes)||leg.minutes<0||leg.minutes>1440||!Number.isFinite(leg.walkingMeters)||leg.walkingMeters<0||leg.walkingMeters>2000000))return {...value,verification:'unavailable',warnings:['部分实际路线尚不可用，请稍后核验']};
  if(i){clock+=Math.ceil(leg.minutes);walking+=leg.walkingMeters;travel+=leg.minutes;}
  const pause=breakBeforeStop(stops,clock,budget);clock+=pause.minutes;
  const hours=await opening(p,day.date);if(hours?.status==='parsed'&&hours.dayState==='closed')warnings.push(p.name+'当日不开放');
  const intervals=hours?.status==='parsed'?hours.intervals?.filter(x=>!x.unknown):[];
  if(intervals?.length){const fit=intervals.find(w=>Math.max(clock,minute(w.start))+p.duration_min<=minute(w.end));if(fit)clock=Math.max(clock,minute(fit.start));else warnings.push(p.name+'无法在开放窗口内游览');}
  stops.push({...p,arrive:clockTime(clock),leave:clockTime(clock+p.duration_min),travelMin:leg?.minutes||0,timingStatus:'route_estimate'});clock+=p.duration_min;
 }
 if(clock>budget.end)warnings.push('实际交通耗时使安排超过结束时间');
 if(value.constraints.prefs.walkingLimitKm&&walking>value.constraints.prefs.walkingLimitKm*1000)warnings.push('点间实际步行距离超过本次上限');
 value.day={...day,stops,routeStatus:warnings.length?'conflict':'live'};
 value.metrics={...value.metrics,walkingMeters:walking,travelMinutes:Math.round(travel),finishAt:clockTime(clock),status:'provider_route_estimate'};
 return {...value,verification:warnings.length?'conflict':'verified',warnings};
}
