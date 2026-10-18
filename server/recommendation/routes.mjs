import {z} from 'zod';
import {requireManagement} from '../operations/permissions.mjs';
import {recommend} from './engine.mjs';
import {tripFeedbackSchema} from './feedback.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export function installRecommendationRoutes(app,{auth,query,transaction,events,production=false}){
 const feedback=tripFeedbackSchema;
 async function ownTrip(c,req){const t=(await c.query('SELECT id,status FROM trips WHERE id=$1 AND user_id=$2 FOR UPDATE',[z.uuid().parse(req.params.id),req.user.id])).rows[0];if(!t)throw fail('行程不存在',404);return t;}
 app.get('/api/journey/trips/:id/feedback',auth,async(req,res)=>{
  const row=await transaction(async c=>{await ownTrip(c,req);return (await c.query('SELECT rating,aspects,experience,updated_at FROM recommendation_trip_feedback WHERE trip_id=$1 AND user_id=$2',[req.params.id,req.user.id])).rows[0]||null;});res.json({feedback:row});
 });
 app.put('/api/journey/trips/:id/feedback',auth,async(req,res)=>{
  const b=feedback.parse(req.body);await transaction(async c=>{const t=await ownTrip(c,req);
   if(b.experience==='trip'&&t.status!=='completed')throw fail('完成旅行后再评价实际体验');
   await c.query(`INSERT INTO recommendation_trip_feedback(trip_id,user_id,rating,aspects,experience) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(trip_id) DO UPDATE SET rating=excluded.rating,aspects=excluded.aspects,experience=excluded.experience,updated_at=now()`,[t.id,req.user.id,b.rating,b.aspects,b.experience]);
  });res.json({ok:true});
 });
 app.delete('/api/journey/trips/:id/feedback',auth,async(req,res)=>{await transaction(async c=>{await ownTrip(c,req);await c.query('DELETE FROM recommendation_trip_feedback WHERE trip_id=$1 AND user_id=$2',[req.params.id,req.user.id]);});res.json({ok:true});});
 const audit=async(req,action)=>events?.append({userId:req.user.id,kind:'admin',action,resourceId:req.params.id,requestId:req.operationRequestId,metadata:{role:req.adminAccess.role}});
 app.get('/api/admin/recommendation/models',requireManagement,async(req,res)=>{
  await audit(req,'recommendation.models_read');res.json({items:(await query('SELECT id,kind,scope,state,metrics,cutoff,created_at FROM recommendation_models ORDER BY created_at DESC LIMIT 20')).rows});
 });
 app.get('/api/admin/recommendation/users/:id/preview',requireManagement,async(req,res)=>{
  const u=(await query('SELECT id,preferences,is_synthetic FROM users WHERE id=$1 AND disabled_at IS NULL',[z.uuid().parse(req.params.id)])).rows[0];if(!u)throw fail('用户不存在',404);
  const r=await recommend(query,u,{persist:false,allowSyntheticModel:!production});await audit(req,'recommendation.preview');
  const ids=r.rows.slice(0,20).map(p=>p.id);const titles=(await query('SELECT id,title FROM posts WHERE id=ANY($1::uuid[])',[ids])).rows;
  res.json({algorithm:r.version,synthetic:!!u.is_synthetic,trace:r.trace,items:ids.map(id=>titles.find(t=>t.id===id))});
 });
 app.get('/api/admin/recommendation/requests/:id',requireManagement,async(req,res)=>{
  const r=(await query('SELECT id,user_id,profile_version,context,trace,algorithm,created_at FROM recommendation_requests WHERE id=$1',[z.uuid().parse(req.params.id)])).rows[0];if(!r)throw fail('记录不存在',404);await audit(req,'recommendation.trace_read');res.json(r);
 });
}
