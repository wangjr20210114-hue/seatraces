/* 查询用户资料、偏好和相关业务记录。 */

import {z} from 'zod';
import {eventFilters} from './routes.mjs';
import {requireManagement} from './permissions.mjs';
import {requireRawCoverage,archivedUserStats,latestTime} from './archive-coverage.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(30),offset:z.coerce.number().int().min(0).max(10000).default(0)});
const list=(rows,limit)=>({items:rows.slice(0,limit),hasMore:rows.length>limit});
const preferences=value=>Object.fromEntries(['pace','transport','crowd','revisit','interests'].filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
const cityNames=value=>(Array.isArray(value)?value:[]).slice(0,5).map(c=>typeof c==='string'?c:c?.name).filter(x=>typeof x==='string').map(x=>x.slice(0,100));

export function installUserInsights(app,{query,events,readInferred=async()=>({inferred:[],inferenceStatus:'not_connected'})}) {
  async function user(id){
    z.uuid().parse(id);
    const row=(await query(`SELECT u.id,u.username,u.nickname,u.avatar,u.role,u.is_synthetic,u.disabled_at,u.preferences,u.created_at,
      EXISTS(SELECT 1 FROM user_emails e WHERE e.user_id=u.id) email_verified
      FROM users u WHERE u.id=$1`,[id])).rows[0];
    if(!row)throw fail('用户不存在',404);
    return {...row,preferences:preferences(row.preferences)};
  }
  async function audit(req,action){
    await events.append({userId:req.user.id,kind:'admin',action,resourceId:req.params.id,requestId:req.operationRequestId,metadata:{role:req.adminAccess.role}});
  }
  app.get('/api/admin/users/:id/summary',requireManagement,async(req,res)=>{
    const u=await user(req.params.id);
    const counts=(await query(`SELECT
      (SELECT count(*)::int FROM trips WHERE user_id=$1) trips,
      (SELECT count(*)::int FROM trips WHERE user_id=$1 AND status='completed') marked_completed,
      (SELECT count(*)::int FROM citywalks WHERE user_id=$1) citywalks,
      (SELECT count(*)::int FROM user_place_wishes WHERE user_id=$1 AND wanted) wishes,
      (SELECT count(*)::int FROM user_place_visits WHERE user_id=$1 AND visited) marked_visits,
      (SELECT count(*)::int FROM user_place_presence WHERE user_id=$1) presence_records,
      (SELECT count(*)::int FROM reactions WHERE user_id=$1 AND kind='save') favorites,
      (SELECT count(*)::int FROM agent_conversations WHERE user_id=$1) conversations,
      (SELECT count(*)::int FROM inbox_messages WHERE user_id=$1 AND read_at IS NULL) unread_messages,
      (SELECT max(created_at) FROM operation_events WHERE user_id=$1 AND kind IN ('request','navigation')) last_activity_at,
      (SELECT count(*)::int FROM operation_events WHERE user_id=$1 AND kind='request' AND status>=500 AND created_at>=now()-interval '7 days') recent_failures`,[u.id])).rows[0];
    const recent=(await query(`SELECT id,title,status,version,request->'cities' cities,created_at,updated_at FROM trips WHERE user_id=$1 ORDER BY updated_at DESC,id LIMIT 5`,[u.id])).rows.map(t=>({...t,cities:cityNames(t.cities)}));
    const archived=await archivedUserStats(query,u.id);
    counts.last_activity_at=latestTime(counts.last_activity_at,archived.last_activity_at);
    counts.archived_operations=archived.count;
    await audit(req,'user.summary_read');
    res.json({user:u,counts,recentTrips:recent,generatedAt:new Date().toISOString(),scope:'all_saved_data',visitDefinition:'用户标记与已有到访检测记录分别展示；保存行程不代表到访。'});
  });
  app.get('/api/admin/users/:id/timeline',requireManagement,async(req,res)=>{
    await user(req.params.id);const {limit,offset}=paging.parse(req.query);
    const [from,to]=eventFilters(req.query);
    const source=z.enum(['all','operation','business','product']).default('all').parse(req.query.source);
    const type=z.enum(['all','navigation','request','admin','trip','citywalk','journey','memory','agent']).default('all').parse(req.query.type);
    const rows=(await query(`WITH timeline AS (
      SELECT 'operation:'||id id,created_at,'operation' source,kind type,action,resource_id,request_id,status,duration_ms,
        jsonb_build_object('metadata',metadata) detail FROM operation_events WHERE user_id=$1 AND kind<>'system' AND created_at >= $2 AND created_at < $3
      UNION ALL SELECT 'product:'||id,created_at,'product',resource_type,event_type,resource_id,request_id,NULL::integer,NULL::integer,
        properties||jsonb_build_object('flowId',flow_id,'version',entity_version) FROM product_events WHERE user_id=$1 AND created_at >= $2 AND created_at < $3
      UNION ALL SELECT 'trip:'||id,created_at,'business','trip','trip.saved',id::text,NULL::uuid,NULL::integer,NULL::integer,
        jsonb_build_object('title',title,'currentVersion',version,'currentStatus',status) FROM trips WHERE user_id=$1 AND created_at >= $2 AND created_at < $3
        AND NOT EXISTS(SELECT 1 FROM product_events p WHERE p.resource_type='trip' AND p.resource_id=trips.id::text AND p.event_type='trip.saved')
      UNION ALL SELECT 'version:'||v.trip_id||':'||v.version,v.created_at,'business','trip','trip.version_saved',v.trip_id::text,NULL::uuid,NULL::integer,NULL::integer,
        jsonb_build_object('title',t.title,'version',v.version) FROM trip_versions v JOIN trips t ON t.id=v.trip_id WHERE t.user_id=$1 AND v.version>1 AND v.created_at >= $2 AND v.created_at < $3
        AND NOT EXISTS(SELECT 1 FROM product_events p WHERE p.resource_type='trip' AND p.resource_id=v.trip_id::text AND p.entity_version=v.version AND p.event_type IN ('trip.updated','trip.status_changed'))
      UNION ALL SELECT 'citywalk:'||id,created_at,'business','citywalk','citywalk.saved',id::text,NULL::uuid,NULL::integer,NULL::integer,
        jsonb_build_object('title',title) FROM citywalks WHERE user_id=$1 AND created_at >= $2 AND created_at < $3
        AND NOT EXISTS(SELECT 1 FROM product_events p WHERE p.resource_type='citywalk' AND p.resource_id=citywalks.id::text AND p.event_type='citywalk.saved')
    ) SELECT * FROM timeline WHERE ($4='all' OR source=$4) AND ($5='all' OR type=$5)
      ORDER BY created_at DESC,id DESC LIMIT $6 OFFSET $7`,[req.params.id,from,to,source,type,limit+1,offset])).rows;
    await requireRawCoverage(query,from,to,{userId:req.params.id});
    await audit(req,'user.timeline_read');res.json({...list(rows,limit),from,to,historicalClicksReconstructed:false});
  });
  app.get('/api/admin/users/:id/trips',requireManagement,async(req,res)=>{
    await user(req.params.id);const {limit,offset}=paging.parse(req.query);
    const rows=(await query(`SELECT id,title,status,version,COALESCE(request->'cities',plan->'cities') cities,request->>'start' start_date,
      request->>'end' end_date,jsonb_array_length(CASE WHEN jsonb_typeof(plan->'days')='array' THEN plan->'days' ELSE '[]' END) day_count,
      created_at,updated_at FROM trips WHERE user_id=$1 ORDER BY updated_at DESC,id LIMIT $2 OFFSET $3`,[req.params.id,limit+1,offset])).rows.map(t=>({...t,cities:cityNames(t.cities)}));
    await audit(req,'user.trips_read');res.json(list(rows,limit));
  });
  app.get('/api/admin/users/:id/citywalks',requireManagement,async(req,res)=>{
    await user(req.params.id);const {limit,offset}=paging.parse(req.query);
    const rows=(await query(`SELECT id,title,city->>'name' city,distance_m,version,verified_route->>'status' verification,
      jsonb_array_length(stops) stop_count,created_at,updated_at FROM citywalks WHERE user_id=$1 ORDER BY updated_at DESC,id LIMIT $2 OFFSET $3`,[req.params.id,limit+1,offset])).rows;
    await audit(req,'user.citywalks_read');res.json(list(rows,limit));
  });
  app.get('/api/admin/users/:id/preferences',requireManagement,async(req,res)=>{
    const u=await user(req.params.id);
    const confirmed=(await query(`SELECT dimension,value,strength,confidence,source,version,updated_at,expires_at,expires_at<=now() expired
      FROM user_travel_memory WHERE user_id=$1 ORDER BY dimension`,[u.id])).rows;
    await audit(req,'user.preferences_read');
    res.json({profile:u.preferences,confirmed,...await readInferred(u.id),rawEvidenceIncluded:false});
  });
  app.get('/api/admin/users/:id/visits',requireManagement,async(req,res)=>{
    await user(req.params.id);const {limit,offset}=paging.parse(req.query);
    const kind=z.enum(['wishes','marked','presence','favorites']).default('wishes').parse(req.query.kind);
    let rows;
    if(kind==='favorites')rows=(await query(`SELECT p.id place_id,p.title name,'post' resource_type,r.created_at recorded_at
      FROM reactions r JOIN posts p ON p.id=r.post_id WHERE r.user_id=$1 AND r.kind='save' ORDER BY r.created_at DESC,p.id LIMIT $2 OFFSET $3`,[req.params.id,limit+1,offset])).rows;
    else {
      const spec={wishes:['user_place_wishes','wanted','updated_at','NULL::date','NULL::integer'],marked:['user_place_visits','visited','updated_at','visited_at','NULL::integer'],presence:['user_place_presence','true','observed_at','NULL::date','dwell_seconds']}[kind];
      const [table,condition,date,visitDate,dwell]=spec;
      rows=(await query(`SELECT v.place_id,p.name,'place' resource_type,v.${date} recorded_at,${visitDate} visited_at,${dwell} dwell_seconds
        FROM ${table} v LEFT JOIN places p ON p.id=v.place_id WHERE v.user_id=$1 AND ${condition}
        ORDER BY v.${date} DESC,v.place_id LIMIT $2 OFFSET $3`,[req.params.id,limit+1,offset])).rows;
    }
    await audit(req,'user.visits_read');res.json({...list(rows,limit),kind,source:kind==='presence'?'existing_presence_detection':kind==='marked'?'user_marked':kind});
  });
  app.get('/api/admin/users/:id/messages',requireManagement,async(req,res)=>{
    await user(req.params.id);const {limit,offset}=paging.parse(req.query);
    const rows=(await query(`SELECT m.id,c.title,m.created_at,m.read_at FROM inbox_messages m JOIN inbox_campaigns c ON c.id=m.campaign_id
      WHERE m.user_id=$1 ORDER BY m.created_at DESC,m.id LIMIT $2 OFFSET $3`,[req.params.id,limit+1,offset])).rows;
    await audit(req,'user.messages_read');res.json(list(rows,limit));
  });
}
