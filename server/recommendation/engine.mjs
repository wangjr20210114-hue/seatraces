import {randomUUID} from 'node:crypto';
import {algorithm,profileVector,cosine,validVector,clamp} from './features.mjs';
import {readProfile} from './profiles.mjs';
import {encode,validateTower,towerScore,rankInputs,rankScore,sigmoid,artifactDigest} from './model.mjs';
export const ruleFineScore=p=>sigmoid(p.affinity*3+p.author*.25+p.city*.7+p.quality*.45+p.fresh*.2-p.seen*.8+p.tower);
export function coarseFeatures(p,userVector,profile,context={},now=Date.now()){
 const affinity=validVector(p.vector)?cosine(userVector,p.vector):0;
 const fresh=1/(1+Math.max(0,(now-new Date(p.created_at))/86400000)/30);
 const author=profile.authors?.[p.user_id]?.weight||0;
 const city=context.city&&p.cities?.includes(context.city)?1:0;
 const quality=clamp(p.features?.quality||0,0,1),seen=p.seen?1:0;
 const coarse=affinity*3+city*.6+author*.2+fresh*.3+quality*.2-seen*.7;
 return {coarse,affinity,author,fresh,quality,city,seen,tower:clamp(p.tower||0,0,1)};
}
export function rerank(rows,{limit=120,explorationEvery=5}={}){
 const left=[...rows],out=[],seenRoutes=new Set();
 while(left.length&&out.length<limit){
  const diverse=left.filter(p=>!(out.length>=2&&out.at(-1).user_id===p.user_id&&out.at(-2).user_id===p.user_id)&&!(p.route_key&&seenRoutes.has(p.route_key)));
  // Near-identical routes are suppressed, rather than silently appended later.
  const pool=diverse.length?diverse:left.filter(p=>!p.route_key||!seenRoutes.has(p.route_key));if(!pool.length)break;
  const explore=out.length%explorationEvery===explorationEvery-1;
  const score=p=>explore?p.parts.fresh*.5+p.parts.quality*.2+p.fine*.3:p.fine-.18*Math.max(0,...out.slice(-5).map(x=>validVector(x.vector)&&validVector(p.vector)?cosine(x.vector,p.vector):0));
  let best=pool[0];for(const p of pool.slice(1))if(score(p)>score(best))best=p;
  out.push({...best,rerankReason:explore?'fresh_exploration':'relevance_and_diversity'});
  if(best.route_key)seenRoutes.add(best.route_key);left.splice(left.findIndex(p=>p.id===best.id),1);
 }
 return out;
}
async function activeModels(query,scope){
 const models=(await query(`SELECT id,kind,artifact,digest FROM recommendation_models WHERE scope=$1 AND state='active'`,[scope])).rows;
 const result={};
 for(const m of models){if(artifactDigest(m.artifact)!==m.digest)continue;
  if(m.kind==='two_tower'&&validateTower(m.artifact))result.tower=m;
  if(m.kind==='ranker'&&m.artifact?.algorithm==='crossed-logistic/1'&&validVector(m.artifact.weights,11))result.ranker=m;
 }
 if(result.ranker?.artifact.towerId!==result.tower?.id)delete result.ranker;
 return result;
}
export async function recommend(query,user,{q='',city='',persist=true,allowSyntheticModel=false}={}){
 const started=performance.now(),profile=await readProfile(query,user),context={city:city.slice(0,100)},vector=profileVector(profile,user.preferences,context);
 const scope=user.is_synthetic&&allowSyntheticModel?'synthetic':'real',models=await activeModels(query,scope);
 const concepts=vector.slice(0,62).map((v,i)=>v>.1?i:null).filter(x=>x!==null);
 const {dimensionKeys}=await import('./features.mjs');
 const values=[user.id,q?'%'+q.replace(/[\\%_]/g,'\\$&')+'%':'',city,concepts.map(i=>dimensionKeys[i]),vector];
 const select=`SELECT p.id,p.user_id,p.tags,p.created_at,p.revision,p.is_synthetic,i.features,i.vector,i.cities,i.route_key,
 EXISTS(SELECT 1 FROM social_impressions si WHERE si.user_id=$1 AND si.post_id=p.id AND si.created_at>now()-interval '7 days' AND si.visible_ms>=1000) seen`;
 const from=`FROM posts p JOIN users u ON u.id=p.user_id LEFT JOIN recommendation_items i ON i.post_id=p.id AND i.revision=p.revision`;
 const where=`p.hidden_at IS NULL AND NOT p.auto_shared AND u.disabled_at IS NULL AND p.user_id<>$1
 AND NOT EXISTS(SELECT 1 FROM social_feedback sf WHERE sf.user_id=$1 AND sf.post_id=p.id)
 AND ($2='' OR p.title ILIKE $2 ESCAPE '\\' OR p.body ILIKE $2 ESCAPE '\\')`;
 // Each channel has its own bounded SQL selection over the whole eligible
 // corpus; it is not a reordering of the latest 120 posts.
 const channels=[
  ['interest',`i.concepts && $4::text[]`,`recommendation_dot(i.vector,$5::real[]) DESC,p.created_at DESC`],
  ['content',`i.post_id IS NOT NULL`,`recommendation_dot(i.vector,$5::real[]) DESC,p.created_at DESC`],
  ['following',`EXISTS(SELECT 1 FROM user_follows f WHERE f.user_id=$1 AND f.author_id=p.user_id)`,`p.created_at DESC`],
  ['destination',`$3<>'' AND $3=ANY(i.cities)`,`p.created_at DESC`],
  ['fresh',`true`,`p.created_at DESC`],
  ['collaborative',`p.id IN (SELECT r.post_id FROM reactions r JOIN (
    SELECT r2.user_id FROM reactions r2 WHERE r2.post_id IN(SELECT post_id FROM reactions WHERE user_id=$1 AND kind IN ('save','like','recommend') ORDER BY created_at DESC LIMIT 100)
    AND r2.user_id<>$1 GROUP BY r2.user_id ORDER BY count(*) DESC LIMIT 30) neighbors ON neighbors.user_id=r.user_id
    GROUP BY r.post_id ORDER BY count(*) DESC LIMIT 100)`,`p.created_at DESC`],
 ];
 const recalls=await Promise.all(channels.map(async([name,condition,order])=>({name,rows:(await query(`${select} ${from} WHERE ${where} AND ${condition}
 AND ($3::text IS NOT NULL) AND ($4::text[] IS NOT NULL) AND ($5::real[] IS NOT NULL) ORDER BY ${order},p.id LIMIT 100`,values)).rows})));
 if(models.tower){const uv=encode(models.tower.artifact,'user',vector);
  recalls.push({name:'two_tower',rows:(await query(`${select},recommendation_dot(e.vector,$7::real[]) tower_logit ${from}
   JOIN recommendation_embeddings e ON e.post_id=p.id AND e.revision=p.revision AND e.model_id=$6
   WHERE ${where} AND ($3::text IS NOT NULL) AND ($4::text[] IS NOT NULL) AND ($5::real[] IS NOT NULL)
   ORDER BY recommendation_dot(e.vector,$7::real[]) DESC,p.id LIMIT 100`,[...values,models.tower.id,uv])).rows.map(p=>({...p,tower:sigmoid(p.tower_logit/Math.sqrt(32)+models.tower.artifact.bias)}))});
 }
 const merged=new Map();for(const {name,rows} of recalls)for(const p of rows){if(!merged.has(p.id))merged.set(p.id,{...p,channels:[]});const v=merged.get(p.id);v.channels.push(name);if(p.tower)v.tower=p.tower;}
 const coarse=[...merged.values()].map(p=>({...p,parts:coarseFeatures({...p,tower:models.tower&&validVector(p.vector)?towerScore(models.tower.artifact,vector,p.vector):0},vector,profile,context)})).sort((a,b)=>b.parts.coarse-a.parts.coarse||a.id.localeCompare(b.id)).slice(0,150);
 const fine=coarse.map(p=>({...p,fine:models.ranker?rankScore(models.ranker.artifact,rankInputs(p.parts)):ruleFineScore(p.parts)}))
  .sort((a,b)=>b.fine-a.fine||a.id.localeCompare(b.id)).slice(0,120);
 const rows=rerank(fine),id=randomUUID(),trace={scope,channels:Object.fromEntries(recalls.map(r=>[r.name,r.rows.length])),counts:{recall:merged.size,coarse:coarse.length,fine:fine.length,rerank:rows.length},
  elapsedMs:Math.round(performance.now()-started),models:{tower:models.tower?.id||null,ranker:models.ranker?.id||null},
  items:rows.map(p=>({id:p.id,revision:p.revision,channels:p.channels,coarse:p.parts.coarse,fine:p.fine,parts:p.parts,reason:p.rerankReason}))};
 if(persist){
  await query(`INSERT INTO recommendation_requests(id,user_id,profile_version,user_vector,context,candidate_ids,trace,algorithm,model_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
   [id,user.id,profile.version,vector,context,rows.map(p=>p.id),trace,algorithm,models.tower?.id||null]);
  await query(`DELETE FROM recommendation_requests WHERE user_id=$1 AND id IN(SELECT id FROM recommendation_requests WHERE user_id=$1 ORDER BY created_at DESC,id DESC OFFSET 400)`,[user.id]);
 }
 return {rows,version:algorithm,requestId:id,trace};
}
