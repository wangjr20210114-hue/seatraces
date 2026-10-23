/* 汇总地点资料覆盖率和核验状态。 */

import {z} from 'zod';
import {requireManagement} from './permissions.mjs';
const str=(v,n=180)=>typeof v==='string'?v.slice(0,n):null;
const arr=v=>Array.isArray(v)?v:[];
const safeURL=v=>{try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
const number=v=>Number.isFinite(Number(v))&&v!==null?Number(v):null;
export function qualityPlace(p={}){
  const facts=Object.entries(p.facts||{}).slice(0,40).map(([field,f])=>({field:str(field,80),status:str(f?.status,40),source:str(f?.source),sourceUrl:safeURL(f?.sourceUrl),verifiedAt:str(f?.verifiedAt,40),sourceTimestamp:str(f?.sourceTimestamp,40)}));
  const h=p.geometricHierarchy||{},s=p.siteHierarchy||{},hasHours=!!(p.hours&&Object.keys(p.hours).length||p.opening_hours||p.openingHours||p.facts?.openingHours?.value),scenic=['attraction','heritage','nature','leisure'].includes(p.category);
  const issues=[];if(!p.name?.trim())issues.push('missing_name');if(scenic&&!hasHours)issues.push('opening_unknown');if(!p.source&&!p.sourceUrl&&!p.source_url)issues.push('source_unknown');if(facts.some(f=>['needs_review','expired','stale'].includes(f.status)))issues.push('facts_need_review');if(h.status==='geometry_unavailable')issues.push('boundary_unavailable');
  return {id:str(p.id),name:str(p.name),aliases:arr(p.aliases).slice(0,50).map(x=>str(x)).filter(Boolean),category:str(p.category,40),city:str(p.city),country:str(p.country||p.country_code,20),source:str(p.source),sourceUrl:safeURL(p.sourceUrl||p.source_url),sourceTimestamp:p.sourceTimestamp||p.source_timestamp||p.verified_at||null,dataStatus:str(p.data_status||p.dataStatus,40),hasHours,coordinateRole:str(p.coordinateRole||p.coordinate_role,60),
    parent:{id:str(p.parentId),depth:number(h.depth),children:number(h.childCount),method:str(h.method),status:str(h.status),buildId:str(h.buildId)},site:{parents:arr(s.parentIds).slice(0,30).map(x=>str(x)).filter(Boolean),children:number(s.childCount),method:str(s.method),status:str(s.status)},facts,factQuality:p.factQuality||{},issues};
}
export function coverageSummary(v){
  const b=v?.build||{},counts={};for(const [k,n]of Object.entries(b.summary||{}))if(typeof n==='number'&&Number.isFinite(n))counts[k]=n;
  return {status:['live','snapshot','not_configured'].includes(v?.status)?v.status:'unknown',cachedAt:v?.cachedAt||null,buildId:str(b.build_id),algorithm:str(b.algorithm),completedAt:b.completed_at||null,counts,rows:number(v?.rows),regions:arr(v?.regions).slice(0,100).map(r=>({region:str(r.region,60),rows:number(r.rows_count),sourceTimestamp:r.pbf_timestamp||null})),countScope:str(v?.countScope,200)};
}
export async function localQuality(query){
  const rows=(await query(`SELECT category,data_status,count(*)::int total,count(*) FILTER(WHERE btrim(name)='')::int missing_name,
    count(*) FILTER(WHERE category='attraction' AND (hours IS NULL OR hours='{}'::jsonb))::int opening_unknown,
    count(*) FILTER(WHERE btrim(source)='' OR btrim(source_url)='')::int missing_source_link FROM places GROUP BY category,data_status ORDER BY category,data_status`)).rows;
  const overlays=(await query(`SELECT (SELECT count(*)::int FROM scenic_parent_checks) provider_checks,
    (SELECT count(*)::int FROM scenic_parent_checks WHERE expires_at<=now()) provider_checks_expired,
    (SELECT count(*)::int FROM scenic_hierarchy_results) inferred_hierarchies,
    (SELECT count(*)::int FROM scenic_hierarchy_results WHERE review_after<=now()) inferred_review_due,
    (SELECT count(*)::int FROM place_signals WHERE expires_at<=now()) expired_signals,
    (SELECT count(*)::int FROM scenic_area_geometries) stored_boundaries`)).rows[0];
  return {scope:'business_database_only',rows,total:rows.reduce((s,r)=>s+r.total,0),overlays,asOf:new Date().toISOString(),definition:'业务库地点与本地补充缓存；不等于云端 OSM 全库。缺少营业时间仅对景点列为待补资料，不阻止餐饮住宿推荐；没有边界不等于没有父景点。'};
}
export function installPlaceQuality(app,{query,events,catalogRequest,overlay=async p=>p}){
  const audit=(req,action,id)=>events.append({userId:req.user.id,kind:'admin',action,resourceId:id,requestId:req.operationRequestId});
  app.get('/api/admin/places/quality',requireManagement,async(req,res)=>res.json(await localQuality(query)));
  let pending,last;
  app.get('/api/admin/places/coverage',requireManagement,async(req,res)=>{
    if(!last||Date.now()-last.at>60000){if(!pending)pending=(async()=>{
      const result=await Promise.allSettled(['/coverage','/site-coverage','/hierarchy-coverage','/entity-coverage'].map(path=>catalogRequest(path)));
      last={at:Date.now(),reports:result.map((r,i)=>({kind:['imports','site','parent','entities'][i],...(r.status==='fulfilled'?coverageSummary(r.value):{status:r.reason?.status===404?'not_supported':'unavailable',code:['catalog_busy','catalog_query_timeout','catalog_unavailable'].includes(r.reason?.code)?r.reason.code:'catalog_unavailable'})}))};
    })().finally(()=>{pending=null;});await pending;}
    res.json({reports:last.reports,checkedAt:new Date(last.at).toISOString(),scope:'server_reported_coverage',definition:'导入行数可能跨地区重复；实体去重数量与原始导入量分列。site 是来源成员关系，parent 是完整几何包含规则推导；缓存或不可用不表示云端实时健康。'});
  });
  app.get('/api/admin/places/search',requireManagement,async(req,res)=>{
    const v=z.object({q:z.string().trim().min(2).max(120),scope:z.enum(['local','cloud']).default('cloud')}).parse(req.query);
    let items,status='live';
    if(v.scope==='cloud'){const r=await catalogRequest('/places',{q:v.q,limit:30});items=r.items||[];status=r.status;}
    else items=(await query("SELECT * FROM places WHERE name ILIKE $1 OR $2=ANY(aliases) ORDER BY name,id LIMIT 30",['%'+v.q.replace(/[\\%_]/g,'\\$&')+'%',v.q])).rows;
    await audit(req,'place.quality_search',v.scope);res.json({items:items.map(qualityPlace),scope:v.scope,status,bounded:true,limit:30,definition:'仅检查本次查询返回的最多 30 个地点，不代表全库缺失率。'});
  });
  app.get('/api/admin/places/inspect',requireManagement,async(req,res)=>{
    const id=z.string().min(1).max(160).parse(req.query.id);let p,status='live',hierarchy=null;
    if(id.startsWith('osm:')){
      z.string().regex(/^osm:(node|way|relation)\/\d{1,20}$/).parse(id);
      const r=await catalogRequest('/place',{id});p=r.item;status=r.status;
      if(p){try{const h=await catalogRequest('/hierarchy',{id,limit:30});hierarchy={status:h.status,ancestors:arr(h.ancestors).slice(0,8).map(qualityPlace),children:arr(h.children).slice(0,30).map(qualityPlace),more:!!h.nextCursor};}catch{hierarchy={status:'unavailable'};}}
    }else p=(await query('SELECT * FROM places WHERE id=$1',[id])).rows[0];
    if(!p)throw Object.assign(Error(status==='not_configured'?'云端地点库尚未配置':'未找到该地点'),{status:status==='not_configured'?503:404});
    p=await overlay(p);
    await audit(req,'place.quality_read',id);res.json({item:qualityPlace(p),status,hierarchy,asOf:new Date().toISOString()});
  });
}
