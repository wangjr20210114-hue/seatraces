import {requireVisiblePost} from '../services/community-interactions.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export async function recordExposure(c,{id,userId,postId,requestId}){
 if(!requestId)return;
 const r=(await c.query(`SELECT candidate_ids,trace FROM recommendation_requests WHERE id=$1 AND user_id=$2 AND created_at>now()-interval '1 day'`,[requestId,userId])).rows[0];
 const position=r?.candidate_ids.indexOf(postId)??-1;if(position<0)throw fail('推荐曝光不属于当前用户或推荐结果',404);
 const item=(await c.query('SELECT vector,revision FROM recommendation_items WHERE post_id=$1',[postId])).rows[0];
 // If the author edited it since recommendation, do not train on a mismatched
 // feature snapshot. Browsing itself still succeeds.
 if(!item||r.trace.items.find(p=>p.id===postId)?.revision!==item.revision)return;
 await c.query(`INSERT INTO recommendation_exposures(id,request_id,user_id,post_id,position,item_vector) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[id,requestId,userId,postId,position,item.vector]);
}
export async function updateExposure(c,{id,visibleMs}){await c.query('UPDATE recommendation_exposures SET visible_ms=greatest(visible_ms,$2) WHERE id=$1',[id,visibleMs]);}
export async function recordInspiration(c,{sessionId,userId,postId}){
 if(!postId)return;
 await requireVisiblePost(c,postId,true);
 if(!(await c.query('SELECT 1 FROM social_adoptions WHERE user_id=$1 AND post_id=$2',[userId,postId])).rowCount)throw fail('请先选择参考这条路线');
 await c.query('INSERT INTO recommendation_trip_sources(session_id,user_id,post_id) VALUES($1,$2,$3)',[sessionId,userId,postId]);
}
export async function confirmAdoption(c,{sessionId,userId,tripId,plan}){
 const source=(await c.query(`SELECT s.post_id,p.snapshot FROM recommendation_trip_sources s JOIN posts p ON p.id=s.post_id WHERE s.session_id=$1 AND s.user_id=$2 AND s.trip_id IS NULL FOR UPDATE OF s`,[sessionId,userId])).rows[0];
 if(!source)return;
 const ids=new Set((source.snapshot.days||[]).flatMap(d=>d.stops||[]).map(p=>p.id));
 if(!(plan.days||[]).some(d=>(d.stops||[]).some(p=>ids.has(p.id))))return;
 await c.query('UPDATE recommendation_trip_sources SET trip_id=$2 WHERE session_id=$1',[sessionId,tripId]);
 await c.query("INSERT INTO recommendation_outcomes(user_id,post_id,kind,active) VALUES($1,$2,'adopt',true)",[userId,source.post_id]);
 await c.query('INSERT INTO style_dirty_users(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET version=style_dirty_users.version+1,updated_at=now()',[userId]);
}
