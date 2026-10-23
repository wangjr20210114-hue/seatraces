/* 查询旅行问卷和行程详情，对比行程修改结果。 */

import {z} from 'zod';
import {eventFilters} from './routes.mjs';
import {requireManagement} from './permissions.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const page=z.object({limit:z.coerce.number().int().min(1).max(100).default(30),offset:z.coerce.number().int().min(0).max(10000).default(0)});
const text=(v,max=160)=>typeof v==='string'?v.slice(0,max):null;
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const array=v=>Array.isArray(v)?v:[];
const city=v=>text(typeof v==='string'?v:v?.name,80);
export function stopSummary(p={}){
  return {id:text(p?.id),name:text(p?.name),category:text(p?.category,40),arrive:text(p?.arrive,8),leave:text(p?.leave,8),
    durationMin:number(p?.duration_min),travelMin:number(p?.travelMin),timingStatus:text(p?.timingStatus,50),locked:!!p?.locked};
}
export function planSummary(p={}){
  if(!p||typeof p!=='object')p={};
  const allDays=array(p.days),days=allDays.slice(0,31).map((d,i)=>({index:i,date:text(d?.date,10),city:city(d?.city),
    routeStatus:text(d?.routeStatus,60),stops:array(d?.stops).slice(0,100).map(stopSummary),truncated:array(d?.stops).length>100}));
  const services=Object.values(p.services&&typeof p.services==='object'?p.services:{}).slice(0,100).filter(Boolean).map(s=>({slotId:text(s.slotId),kind:text(s.kind,40),days:array(s.days).filter(x=>Number.isInteger(x)&&x>=0&&x<31),selectedAt:text(s.selectedAt,40),place:stopSummary(s.candidate||{})}));
  return {days,services,routeStatus:text(p.routeStatus,60),source:text(p.source,80),generatedAt:text(p.generatedAt,40),
    warnings:array(p.warnings).slice(0,50).map(w=>text(w,300)).filter(Boolean),truncated:allDays.length>31||days.some(d=>d.truncated),preciseOriginIncluded:false};
}
export function comparePlans(before,after){
  const a=planSummary(before),b=planSummary(after),days=[];
  for(let i=0;i<Math.max(a.days.length,b.days.length);i++){
    const left=a.days[i],right=b.days[i],ls=left?.stops||[],rs=right?.stops||[];
    const keyed=stops=>{const count=new Map();return stops.map((s,index)=>{const key=s.id||('name:'+s.name);const n=count.get(key)||0;count.set(key,n+1);return {...s,key:key+'#'+n,index};});};
    const l=keyed(ls),r=keyed(rs),lm=new Map(l.map(s=>[s.key,s])),rm=new Map(r.map(s=>[s.key,s]));
    const changed=r.filter(s=>lm.has(s.key)&&['arrive','leave','durationMin','locked'].some(k=>s[k]!==lm.get(s.key)[k]));
    days.push({index:i,beforeDate:left?.date||null,afterDate:right?.date||null,beforeCity:left?.city||null,afterCity:right?.city||null,
      added:r.filter(s=>!lm.has(s.key)).map(s=>({id:s.id,name:s.name})),removed:l.filter(s=>!rm.has(s.key)).map(s=>({id:s.id,name:s.name})),
      reordered:r.filter(s=>lm.has(s.key)&&s.index!==lm.get(s.key).index).map(s=>({id:s.id,name:s.name,from:lm.get(s.key).index+1,to:s.index+1})),
      changed:changed.map(s=>({id:s.id,name:s.name,before:lm.get(s.key),after:s}))});
  }
  const services=[...new Set([...a.services,...b.services].map(s=>s.slotId))].map(slotId=>({slotId,before:a.services.find(s=>s.slotId===slotId)||null,after:b.services.find(s=>s.slotId===slotId)||null})).filter(s=>JSON.stringify(s.before)!==JSON.stringify(s.after));
  return {days,services,truncated:a.truncated||b.truncated,comparison:'saved_plan_snapshots'};
}
export function installJourneyInsights(app,{query,events}){
  const audit=(req,action,id)=>events.append({userId:req.user.id,kind:'admin',action,resourceId:id,requestId:req.operationRequestId,metadata:{role:req.adminAccess.role}});
  const load=async id=>{z.uuid().parse(id);const t=(await query('SELECT t.*,u.username FROM trips t JOIN users u ON u.id=t.user_id WHERE t.id=$1',[id])).rows[0];if(!t)throw fail('行程不存在',404);return t;};
  async function snapshot(trip,version){
    if(version===trip.version)return {version,plan:trip.plan,created_at:trip.updated_at,current:true};
    const v=(await query('SELECT version,plan,created_at FROM trip_versions WHERE trip_id=$1 AND version=$2',[trip.id,version])).rows[0];
    if(!v)throw fail('该版本未保存',404);return {...v,current:false};
  }
  app.get('/api/admin/journeys',requireManagement,async(req,res)=>{
    const {limit,offset}=page.parse(req.query),[from,to,userId]=eventFilters({from:req.query.from,to:req.query.to,userId:req.query.userId}),kind=z.enum(['trip','citywalk']).default('trip').parse(req.query.kind);
    const q=z.string().trim().max(80).default('').parse(req.query.q).replace(/[\\%_]/g,'\\$&');
    const state=z.enum(['all','planned','completed','verified','unverified']).default('all').parse(req.query.state);
    if(kind==='trip'&&!['all','planned','completed'].includes(state)||kind==='citywalk'&&!['all','verified','unverified'].includes(state))throw fail('筛选状态不适用于当前类型');
    let rows;
    if(kind==='trip')rows=(await query(`SELECT t.id,t.user_id,u.username,t.title,t.status,t.version,t.created_at,t.updated_at,
      t.request->'cities' cities,t.request->>'start' start_date,t.request->>'end' end_date,
      jsonb_array_length(CASE WHEN jsonb_typeof(t.plan->'days')='array' THEN t.plan->'days' ELSE '[]' END) day_count,
      t.plan->>'routeStatus' route_status
      FROM trips t JOIN users u ON u.id=t.user_id WHERE t.updated_at >= $1 AND t.updated_at < $2
      AND ($3::uuid IS NULL OR t.user_id=$3) AND (t.title ILIKE $4 OR u.username ILIKE $4) AND ($5='all' OR t.status=$5)
      ORDER BY t.updated_at DESC,t.id DESC LIMIT $6 OFFSET $7`,[from,to,userId,'%'+q+'%',state,limit+1,offset])).rows.map(t=>({...t,cities:array(t.cities).slice(0,5).map(city).filter(Boolean)}));
    else rows=(await query(`SELECT t.id,t.user_id,u.username,t.title,t.version,t.city->>'name' city,t.distance_m,t.verified_route->>'status' verification,
      jsonb_array_length(t.stops) stop_count,t.created_at,t.updated_at FROM citywalks t JOIN users u ON u.id=t.user_id
      WHERE t.updated_at >= $1 AND t.updated_at < $2 AND ($3::uuid IS NULL OR t.user_id=$3) AND (t.title ILIKE $4 OR u.username ILIKE $4)
      AND ($5='all' OR ($5='verified' AND t.verified_route->>'status'='verified') OR ($5='unverified' AND coalesce(t.verified_route->>'status','')<>'verified'))
      ORDER BY t.updated_at DESC,t.id DESC LIMIT $6 OFFSET $7`,[from,to,userId,'%'+q+'%',state,limit+1,offset])).rows;
    await audit(req,'journey.list_read',userId);res.json({kind,items:rows.slice(0,limit),hasMore:rows.length>limit,from,to});
  });
  app.get('/api/admin/journeys/trips/:id',requireManagement,async(req,res)=>{
    const trip=await load(req.params.id),version=z.coerce.number().int().positive().default(trip.version).parse(req.query.version),s=await snapshot(trip,version);
    const versions=(await query(`SELECT version,created_at FROM trip_versions WHERE trip_id=$1 ORDER BY version DESC LIMIT 101`,[trip.id])).rows;
    if(!versions.some(v=>v.version===trip.version))versions.unshift({version:trip.version,created_at:trip.updated_at});
    await audit(req,'journey.trip_read',trip.id);
    res.json({trip:{id:trip.id,userId:trip.user_id,username:trip.username,title:trip.title,status:trip.status,currentVersion:trip.version,createdAt:trip.created_at,updatedAt:trip.updated_at},
      request:{cities:array(trip.request?.cities).slice(0,5).map(city).filter(Boolean),start:text(trip.request?.start,10),end:text(trip.request?.end,10)},
      selectedVersion:version,versionRecordedAt:s.created_at,plan:planSummary(s.plan),versions:versions.slice(0,100),versionsTruncated:versions.length>100,
      snapshotScope:'历史版本仅包含已保存的 plan；标题、状态和问卷是当前值，不补造历史问卷。'});
  });
  app.get('/api/admin/journeys/trips/:id/compare',requireManagement,async(req,res)=>{
    const trip=await load(req.params.id),v=z.object({fromVersion:z.coerce.number().int().positive(),toVersion:z.coerce.number().int().positive()}).parse(req.query);
    const a=await snapshot(trip,v.fromVersion),b=await snapshot(trip,v.toVersion);
    await audit(req,'journey.compare_read',trip.id);res.json({tripId:trip.id,...v,...comparePlans(a.plan,b.plan)});
  });
  app.get('/api/admin/journeys/citywalks/:id',requireManagement,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),w=(await query('SELECT w.*,u.username FROM citywalks w JOIN users u ON u.id=w.user_id WHERE w.id=$1',[id])).rows[0];
    if(!w)throw fail('路线不存在',404);
    await audit(req,'journey.citywalk_read',id);
    res.json({id:w.id,userId:w.user_id,username:w.username,title:w.title,city:city(w.city),version:w.version,distanceM:w.distance_m,
      verification:text(w.verified_route?.status,40),stops:array(w.stops).slice(0,100).map(stopSummary),truncated:w.stops.length>100,
      createdAt:w.created_at,updatedAt:w.updated_at,historyAvailable:false,distanceDefinition:w.verified_route?.status==='verified'?'verified_walking_distance':'unverified_saved_distance'});
  });
}
