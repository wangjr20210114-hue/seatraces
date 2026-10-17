import {algorithm,contentFeatures,vectorize,profileVector,weights,clamp} from './features.mjs';
import {answerFeatures,interestMap} from '../social/features.mjs';
import {styleForPlanning} from '../social/style-store.mjs';
import {encode,validateTower,artifactDigest} from './model.mjs';
export async function refreshItem(c,id){
 const p=(await c.query(`SELECT id,title,body,tags,revision,snapshot->'cities' cities,
  jsonb_array_length(CASE WHEN jsonb_typeof(snapshot->'days')='array' THEN snapshot->'days' ELSE '[]' END) day_count,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id',s->'id','name',s->'name','category',s->'category')),'[]') FROM (SELECT s FROM jsonb_path_query(snapshot,'$.days[*].stops[*]') s LIMIT 200) x) stops,
  jsonb_build_object('distance_m',snapshot->'distance_m') snapshot FROM posts WHERE id=$1`,[id])).rows[0];
 if(!p)return;
 const f=contentFeatures(p);
 await c.query(`INSERT INTO recommendation_items(post_id,revision,concepts,cities,features,vector,route_key,algorithm)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(post_id) DO UPDATE SET revision=excluded.revision,concepts=excluded.concepts,
 cities=excluded.cities,features=excluded.features,vector=excluded.vector,route_key=excluded.route_key,algorithm=excluded.algorithm,updated_at=now()`,
 [p.id,p.revision,Object.keys(f.values),f.cities,f,vectorize(f.values,f.cities,f.facts),f.routeKey,algorithm]);
 for(const m of (await c.query("SELECT id,artifact,digest FROM recommendation_models WHERE kind='two_tower' AND state='active'")).rows){
  if(!validateTower(m.artifact)||artifactDigest(m.artifact)!==m.digest)continue;
  await c.query(`INSERT INTO recommendation_embeddings(model_id,post_id,revision,vector) VALUES($1,$2,$3,$4)
   ON CONFLICT(model_id,post_id) DO UPDATE SET revision=excluded.revision,vector=excluded.vector`,[m.id,p.id,p.revision,encode(m.artifact,'item',vectorize(f.values,f.cities,f.facts))]);
 }
}
export async function backfillItems(query){
 let last='00000000-0000-0000-0000-000000000000',count=0;
 for(;;){const rows=(await query(`SELECT p.id FROM posts p LEFT JOIN recommendation_items i ON i.post_id=p.id
  WHERE p.id>$1 AND p.hidden_at IS NULL AND (i.post_id IS NULL OR i.revision<>p.revision OR i.algorithm<>$2) ORDER BY p.id LIMIT 50`,[last,algorithm])).rows;
  if(!rows.length)break;for(const p of rows){await refreshItem({query},p.id);count++;}last=rows.at(-1).id;
 }return count;
}
export function aggregateSignals(evidence,now=Date.now()){
 const travel={},content={};
 for(const [window,days,half] of [['short',14,7],['long',365,90]]){
  const groups=new Map();
  for(const e of evidence){const age=(now-new Date(e.at))/86400000;if(!Number.isFinite(age)||age<0||age>days)continue;
   const key=e.space+':'+e.dimension,g=groups.get(key)||{space:e.space,dimension:e.dimension,sum:0,weight:0,origins:new Set()};
   const w=clamp(e.weight,0,5)*2**(-age/half);g.sum+=e.value*w;g.weight+=w;g.origins.add(e.origin);groups.set(key,g);
  }
  for(const g of groups.values()){const target=g.space==='travel'?travel:content;
   (target[g.dimension]??={})[window]={value:clamp(g.sum/g.weight),confidence:Math.min(.95,g.weight/(g.weight+4))*(g.origins.size===1?.65:1),samples:g.origins.size};}
 }
 return {travel,content};
}
export async function buildProfile(c,userId){
 const evidence=[];
 const add=(space,origin,values,weight,at,reason,sign=1)=>{for(const [dimension,value] of Object.entries(values||{})){
  if(dimension.startsWith('format.')&&space==='travel')continue;
  evidence.push({space,origin,dimension,value:clamp(value*sign),weight,at,reason});}};
 const posts=(await c.query(`WITH signals AS (
 SELECT post_id,max(w) w,max(at) at FROM (
 SELECT post_id,CASE kind WHEN 'save' THEN 3 WHEN 'recommend' THEN 2 ELSE 1 END::float w,created_at at FROM reactions WHERE user_id=$1
 UNION ALL SELECT post_id,least(.3,sum(dwell_seconds)/400.0),max(created_at) FROM browse_events WHERE user_id=$1 AND day>CURRENT_DATE-365 GROUP BY post_id
 UNION ALL SELECT post_id,1,created_at FROM social_adoptions WHERE user_id=$1
 UNION ALL SELECT post_id,4,created_at FROM recommendation_trip_sources WHERE user_id=$1 AND trip_id IS NOT NULL
 ) x GROUP BY post_id), ids AS (SELECT post_id FROM signals UNION SELECT post_id FROM social_feedback WHERE user_id=$1 UNION SELECT post_id FROM comments WHERE user_id=$1 AND hidden_at IS NULL)
 SELECT p.id,i.features,coalesce(s.w,0) w,coalesce(f.created_at,s.at,cm.at) at,f.post_id IS NOT NULL negative,cm.at comment_at
 FROM ids JOIN posts p ON p.id=ids.post_id JOIN users u ON u.id=p.user_id JOIN recommendation_items i ON i.post_id=p.id AND i.revision=p.revision
 LEFT JOIN signals s ON s.post_id=p.id LEFT JOIN social_feedback f ON f.post_id=p.id AND f.user_id=$1
 LEFT JOIN LATERAL(SELECT max(created_at) at FROM comments WHERE user_id=$1 AND post_id=p.id AND hidden_at IS NULL) cm ON true
 WHERE p.user_id<>$1 AND p.hidden_at IS NULL AND NOT p.auto_shared AND u.disabled_at IS NULL
 ORDER BY coalesce(f.created_at,s.at,cm.at) DESC,p.id LIMIT 300`,[userId])).rows;
 for(const p of posts){const vals=p.features.values,w=p.negative?weights.not_interested:p.w,sign=p.negative?-1:1;
  if(w){add('content','post:'+p.id,vals,w,p.at,p.negative?'not_interested':'interaction',sign);
   // Browsing is useful for content, but alone must not redefine travel habits.
   if(p.negative||p.w>=1)add('travel','post:'+p.id,vals,w,p.at,p.negative?'not_interested':'interaction',sign);}
  if(p.comment_at&&!p.negative)add('content','comment:'+p.id,vals,weights.comment,p.comment_at,'topic_participation');
 }
 const trips=(await c.query(`SELECT id,updated_at,request->'interests' interests,request->>'pace' pace,request->>'transport' transport,request->>'crowd' crowd,request->>'revisit' revisit
 FROM trips WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100`,[userId])).rows;
 for(const t of trips)add('travel','trip:'+t.id,answerFeatures(t),1,t.updated_at,'trip_answers');
 const choices=(await c.query('SELECT * FROM user_place_style_choices WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 300',[userId])).rows;
 for(const p of choices)add('travel','choice:'+p.place_id,p.features,p.value<0?.5:2,p.updated_at,p.kind,p.value);
 const walkFacts=(await c.query('SELECT source_id,features,updated_at FROM trip_features WHERE user_id=$1 AND source_kind=\'citywalk\' ORDER BY updated_at DESC LIMIT 100',[userId])).rows;
 for(const w of walkFacts)add('travel','walk:'+w.source_id,w.features.values,1.5,w.updated_at,'chosen_citywalk');
 const feedback=(await c.query(`SELECT f.*,t.request->'interests' interests FROM recommendation_trip_feedback f JOIN trips t ON t.id=f.trip_id WHERE f.user_id=$1 ORDER BY f.updated_at DESC LIMIT 100`,[userId])).rows;
 for(const f of feedback){
  if(f.aspects.places)add('travel','satisfaction:'+f.trip_id,answerFeatures({interests:f.interests||[]}),f.experience==='trip'?weights.satisfaction:1,f.updated_at,'place_satisfaction',(f.aspects.places-3)/2);
  if(f.aspects.pace==='too_busy')add('travel','pace:'+f.trip_id,{'pace.relaxed':1},f.experience==='trip'?3:1,f.updated_at,'pace_satisfaction');
  if(f.aspects.pace==='too_slow')add('travel','pace:'+f.trip_id,{'pace.full':1},f.experience==='trip'?3:1,f.updated_at,'pace_satisfaction');
 }
 const authors=Object.fromEntries((await c.query(`SELECT f.author_id FROM user_follows f JOIN users u ON u.id=f.author_id WHERE f.user_id=$1 AND u.disabled_at IS NULL ORDER BY f.created_at DESC LIMIT 200`,[userId])).rows.map(r=>[r.author_id,{value:1,weight:weights.follow}]));
 const profile={...aggregateSignals(evidence),authors};
 const preferences=(await c.query('SELECT preferences FROM users WHERE id=$1',[userId])).rows[0]?.preferences;
 await c.query(`INSERT INTO recommendation_profiles(user_id,travel,content,authors,vector,evidence,algorithm)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id) DO UPDATE SET travel=excluded.travel,content=excluded.content,
 authors=excluded.authors,vector=excluded.vector,evidence=excluded.evidence,version=recommendation_profiles.version+1,algorithm=excluded.algorithm,updated_at=now()`,
 [userId,profile.travel,profile.content,authors,profileVector(profile,preferences),JSON.stringify(evidence.slice(-200)),algorithm]);
 return {evidence: evidence.length,travelDimensions:Object.keys(profile.travel).length,contentDimensions:Object.keys(profile.content).length,authors:Object.keys(authors).length};
}
export async function readProfile(query,user){
 const p=(await query('SELECT * FROM recommendation_profiles WHERE user_id=$1',[user.id])).rows[0];
 if(!p||Date.now()-new Date(p.updated_at)>86400000)await query('INSERT INTO style_dirty_users(user_id) SELECT id FROM users WHERE id=$1 ON CONFLICT DO NOTHING',[user.id]);
 return p||{user_id:user.id,travel:{},content:{},authors:{},vector:profileVector({},user.preferences),version:0,algorithm};
}
export async function recommendationPreferences(query,user,current={}){
 const legacy=await styleForPlanning(query,user,current),p=await readProfile(query,user),inferred={};
 for(const [tag,keys] of Object.entries(interestMap)){
  const vals=keys.map(k=>p.travel[k]).filter(Boolean);if(vals.length)inferred[tag]=vals.reduce((sum,v)=>sum+(v.long?.value||0)*(v.long?.confidence||0)*.65+(v.short?.value||0)*(v.short?.confidence||0)*.35,0)/vals.length;
 }
 return {...legacy,styleWeights:p.version?inferred:legacy.styleWeights,styleVersion:algorithm};
}
