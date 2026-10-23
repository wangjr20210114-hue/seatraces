/* 汇总旅行和社区行为，更新兴趣画像并参与规划排序。 */

import {styleAlgorithm,styleDimensions,featuresFromPlaces,routeFeatures,aggregateEvidence,planningStyle,answerFeatures} from './features.mjs';
import {memoryPreferences} from '../agent/memory.mjs';
const compactStops=expression=>`(SELECT coalesce(jsonb_agg(jsonb_build_object('name',s->'name','category',s->'category')),'[]') FROM (SELECT s FROM jsonb_path_query(${expression},'$.days[*].stops[*]') s LIMIT 200) x)`;
export async function enqueueStyle(query,userId){
 await query(`INSERT INTO style_dirty_users(user_id) SELECT id FROM users WHERE id=$1 ON CONFLICT DO NOTHING`,[userId]);
}
export async function readStyle(query,userId){
 const rows=(await query('SELECT dimension,window_kind AS "window",value,strength,confidence,samples,algorithm,updated_at FROM user_style_dimensions WHERE user_id=$1 ORDER BY dimension,window_kind',[userId])).rows;
 if(!rows.length||Date.now()-new Date(rows[0].updated_at)>86400000)await enqueueStyle(query,userId);
 return rows;
}
export async function styleForPlanning(query,user,current={}){
 const [rows,memory]=await Promise.all([readStyle(query,user.id),memoryPreferences(query,user.id)]);
 return planningStyle(rows.filter(r=>r.window==='long'),{...user.preferences,...memory},current);
}
export async function rebuildStyle(c,userId){
 const evidence=[],featurePosts=[];
 const add=(origin,values,weight,source,date,sign=1)=>{for(const [dimension,value] of Object.entries(values))evidence.push({origin,dimension,value:value*sign,weight,source,observed_at:date});};
 const posts=(await c.query(`WITH signals AS(
   SELECT post_id,max(weight) weight,max(observed_at) observed_at FROM (
    SELECT post_id,CASE kind WHEN 'save' THEN 3 WHEN 'recommend' THEN 2 ELSE 1 END::float weight,created_at observed_at FROM reactions WHERE user_id=$1
    UNION ALL SELECT post_id,least(.2,sum(dwell_seconds)/600.0)::float weight,max(created_at) observed_at FROM browse_events WHERE user_id=$1 AND day>CURRENT_DATE-365 GROUP BY post_id
    UNION ALL SELECT post_id,3::float,created_at FROM social_adoptions WHERE user_id=$1
   ) s GROUP BY post_id
 ), all_ids AS(SELECT post_id FROM signals UNION SELECT post_id FROM social_feedback WHERE user_id=$1)
 SELECT p.id,p.tags,p.revision,p.snapshot->'cities' cities,${compactStops('p.snapshot')} stops,
   coalesce(s.weight,0) weight,coalesce(f.created_at,s.observed_at) observed_at,f.post_id IS NOT NULL negative
 FROM all_ids a JOIN posts p ON p.id=a.post_id JOIN users author ON author.id=p.user_id LEFT JOIN signals s ON s.post_id=p.id
 LEFT JOIN social_feedback f ON f.post_id=p.id AND f.user_id=$1
 WHERE p.user_id<>$1 AND p.hidden_at IS NULL AND NOT p.auto_shared AND author.disabled_at IS NULL
 ORDER BY coalesce(f.created_at,s.observed_at) DESC LIMIT 300`,[userId])).rows;
 for(const p of posts){const features=routeFeatures({cities:p.cities||[],days:[{stops:p.stops}]},p.tags);
  featurePosts.push({post_id:p.id,revision:p.revision,features});
  add('post:'+p.id,features.values,p.negative?2:p.weight,p.negative?'not_interested':p.weight>=3?'save_or_adopt':p.weight>=1?'reaction':'effective_view',p.observed_at,p.negative?-1:1);
 }
 const trips=(await c.query(`SELECT id,version,updated_at,jsonb_build_object('interests',request->'interests','pace',request->'pace','transport',request->'transport','crowd',request->'crowd','revisit',request->'revisit') answers,plan->'cities' cities,
  jsonb_array_length(CASE WHEN jsonb_typeof(plan->'days')='array' THEN plan->'days' ELSE '[]' END) day_count,
  ${compactStops('plan')} stops FROM trips WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100`,[userId])).rows;
 const featureTrips=[];
 for(const p of trips){const features=routeFeatures({cities:p.cities||[],days:[{stops:p.stops}]});features.facts.dayCount=p.day_count;
  featureTrips.push({source_kind:'journey',source_id:p.id,source_version:p.version,features});
  add('trip:'+p.id,answerFeatures(p.answers),1,'trip_answers',p.updated_at);
 }
 const walks=(await c.query(`SELECT id,version,updated_at,city,distance_m,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('name',s->'name','category',s->'category')),'[]') FROM (SELECT s FROM jsonb_array_elements(stops) s LIMIT 100) x) stops
  FROM citywalks WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100`,[userId])).rows;
 for(const w of walks){const features=routeFeatures({cities:[w.city.name],days:[{stops:w.stops}],distance_m:w.distance_m});features.values['mobility.walking']=1;
  featureTrips.push({source_kind:'citywalk',source_id:w.id,source_version:w.version,features});add('walk:'+w.id,features.values,1.5,'chosen_citywalk',w.updated_at);
 }
 const choices=(await c.query('SELECT * FROM user_place_style_choices WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 300',[userId])).rows;
 for(const p of choices)add('choice:'+p.place_id,p.features,p.value<0?.5:2,p.kind==='wish'?'place_wish':'manual_edit',p.updated_at,p.value);
 const unique=new Map();for(const r of evidence){const key=r.origin+':'+r.dimension,old=unique.get(key);if(!old||r.weight>old.weight)unique.set(key,r);}
 const rows=[...unique.values()];
 await c.query('DELETE FROM user_style_evidence WHERE user_id=$1',[userId]);
 if(rows.length)await c.query(`INSERT INTO user_style_evidence(user_id,origin,dimension,value,weight,source,observed_at)
  SELECT $1,x.origin,x.dimension,x.value,x.weight,x.source,x.observed_at FROM jsonb_to_recordset($2::jsonb) AS x(origin text,dimension text,value float,weight float,source text,observed_at timestamptz)`,[userId,JSON.stringify(rows)]);
 const aggregates=['short','long'].flatMap(window=>aggregateEvidence(rows,{window}));
 await c.query('DELETE FROM user_style_dimensions WHERE user_id=$1',[userId]);
 if(aggregates.length)await c.query(`INSERT INTO user_style_dimensions(user_id,dimension,window_kind,value,strength,confidence,samples,algorithm)
  SELECT $1,x.dimension,x.window_kind,x.value,x.strength,x.confidence,x.samples,$3 FROM jsonb_to_recordset($2::jsonb) AS x(dimension text,window_kind text,value float,strength float,confidence float,samples int)`,[userId,JSON.stringify(aggregates.map(({window,...r})=>({...r,window_kind:window}))),styleAlgorithm]);
 if(featurePosts.length)await c.query(`INSERT INTO post_features(post_id,revision,features,algorithm)
  SELECT x.post_id,x.revision,x.features,$2 FROM jsonb_to_recordset($1::jsonb) AS x(post_id uuid,revision int,features jsonb)
  ON CONFLICT(post_id) DO UPDATE SET revision=excluded.revision,features=excluded.features,algorithm=excluded.algorithm,updated_at=now()`,[JSON.stringify(featurePosts),styleAlgorithm]);
 await c.query('DELETE FROM trip_features WHERE user_id=$1',[userId]);
 if(featureTrips.length)await c.query(`INSERT INTO trip_features(user_id,source_kind,source_id,source_version,features)
  SELECT $1,x.source_kind,x.source_id,x.source_version,x.features FROM jsonb_to_recordset($2::jsonb) AS x(source_kind text,source_id uuid,source_version int,features jsonb)`,[userId,JSON.stringify(featureTrips)]);
 return {evidence:rows.length,dimensions:aggregates.length,posts:posts.length,trips:trips.length,walks:walks.length};
}
export function createStyleWorker({query,transaction,intervalMs=3000,onError=()=>{},afterRebuild=async()=>{}}){
 let timer,running=false;
 async function tick(){if(running)return;running=true;
  try{return await transaction(async c=>{const j=(await c.query('SELECT user_id,version FROM style_dirty_users ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED')).rows[0];if(!j)return null;
   const result=await rebuildStyle(c,j.user_id);await afterRebuild(c,j.user_id);await c.query('DELETE FROM style_dirty_users WHERE user_id=$1 AND version=$2',[j.user_id,j.version]);return result;
  });}catch(e){onError(e);return {error:true};}finally{running=false;}}
 return {tick,start(){if(!timer){timer=setInterval(()=>void tick(),intervalMs);timer.unref();}},stop(){clearInterval(timer);timer=null;}};
}
export async function explainStyle(query,userId){
 const rows=await readStyle(query,userId);
 const evidence=(await query('SELECT origin,dimension,value,weight,source,observed_at FROM user_style_evidence WHERE user_id=$1 ORDER BY observed_at DESC LIMIT 100',[userId])).rows;
 return {inferred:rows,dimensions:styleDimensions,evidence,algorithm:styleAlgorithm,inferenceStatus:rows.length?'available':'pending_or_unknown',coverage:{posts:300,trips:100,walks:100,choices:300,windows:{short:14,long:365}},rawEvidenceIncluded:false};
}
export async function rankSocial(query,posts,user){
 const profile=await styleForPlanning(query,user),rows=(await query('SELECT post_id,features FROM post_features WHERE post_id=ANY($1::uuid[])',[posts.map(p=>p.id)])).rows;
 const featureMap=new Map(rows.map(r=>[r.post_id,r.features]));
 const follows=new Set((await query('SELECT author_id FROM user_follows WHERE user_id=$1',[user.id])).rows.map(r=>r.author_id));
 const ranked=posts.map((p,i)=>({...p,rank:i,values:featureMap.get(p.id)?.values||featuresFromPlaces([],p.tags)}));
 const dimensions=(await readStyle(query,user.id)).filter(r=>r.window==='long');
 for(const p of ranked){p.score=1/(1+Math.max(0,(Date.now()-new Date(p.created_at))/86400000)/7)+(follows.has(p.user_id)?.3:0);
  for(const r of dimensions)if(r.confidence>=.2)p.score+=(p.values[r.dimension]||0)*r.value*r.confidence;
  for(const t of profile.interests||[])if(p.tags.includes(t))p.score+=2;
 }
 ranked.sort((a,b)=>b.score-a.score||a.rank-b.rank);const result=[];
 while(ranked.length){let index=result.length&&result.length%5===4?ranked.reduce((best,p,i)=>p.rank<ranked[best].rank?i:best,0):0;
  if(result.length>=2&&result.at(-1).user_id===result.at(-2).user_id&&ranked[index].user_id===result.at(-1).user_id){const other=ranked.findIndex(p=>p.user_id!==result.at(-1).user_id);if(other>=0)index=other;}
  result.push(ranked.splice(index,1)[0]);
 }
 return {rows:result,version:styleAlgorithm};
}
export async function refreshPostFeatures(c,id){
 const p=(await c.query(`SELECT id,revision,tags,snapshot->'cities' cities,${compactStops('snapshot')} stops FROM posts WHERE id=$1`,[id])).rows[0];
 if(!p)return;
 await c.query(`INSERT INTO post_features(post_id,revision,features,algorithm) VALUES($1,$2,$3,$4)
  ON CONFLICT(post_id) DO UPDATE SET revision=excluded.revision,features=excluded.features,algorithm=excluded.algorithm,updated_at=now()`,
 [p.id,p.revision,JSON.stringify(routeFeatures({cities:p.cities||[],days:[{stops:p.stops}]},p.tags)),styleAlgorithm]);
}
export async function recordPlaceChoice(c,{userId,place,kind='wish',value=1,tripId=null}){
 if(value===0){await c.query('DELETE FROM user_place_style_choices WHERE user_id=$1 AND place_id=$2 AND kind=$3',[userId,place.id,kind]);return;}
 const features=featuresFromPlaces([place]);
 await c.query(`INSERT INTO user_place_style_choices(user_id,place_id,trip_id,kind,value,features) VALUES($1,$2,$3,$4,$5,$6)
  ON CONFLICT(user_id,place_id,kind) DO UPDATE SET trip_id=excluded.trip_id,value=excluded.value,features=excluded.features,updated_at=now()`,[userId,place.id,tripId,kind,value,JSON.stringify(features)]);
}
