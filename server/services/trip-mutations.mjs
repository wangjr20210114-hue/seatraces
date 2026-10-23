/* 校验行程修改请求，执行站点增删、替换和移动。 */

import {z} from 'zod';
import {applyEdit} from '../planner.mjs';
export const operationSchema=z.object({type:z.enum(['lock','remove','replace','add','move','apply_preview']),day:z.number().int().min(0).max(29),
 placeId:z.string().max(80).optional(),newPlaceId:z.string().max(80).optional(),to:z.number().int().min(0).max(20).optional(),previewId:z.uuid().optional(),
}).strict().refine(v=>v.type!=='apply_preview'||Boolean(v.previewId));
export function tripMutationHandler({transaction,ownTrip,recordPlaceChoice=async()=>{},applyPreview}){
 return async(req,res)=>{
  const b=z.object({version:z.number().int().positive(),operation:operationSchema.optional(),restoreVersion:z.number().int().positive().optional(),status:z.enum(['planned','completed']).optional()})
   .refine(x=>[x.operation,x.restoreVersion,x.status].filter(Boolean).length===1).parse(req.body);
  const result=await transaction(async c=>{
   const t=await ownTrip(req.params.id,req.user.id,c,true);if(t.version!==b.version)throw Object.assign(Error('行程已更新，请刷新后再试'),{status:409});
   let plan=t.plan,reason='状态更新';
   if(b.operation){
    if(b.operation.type==='apply_preview')plan=await applyPreview(c,t,b.operation,req.user.id);
    else{
     const ps=(await c.query("SELECT * FROM places WHERE category='attraction' AND city=ANY($1)",[t.plan.cities.map(x=>x.name)])).rows;
     plan=applyEdit(plan,b.operation,ps);
     const before=new Map(t.plan.days.flatMap(d=>d.stops||[]).map(p=>[p.id,p])),after=new Map(plan.days.flatMap(d=>d.stops||[]).map(p=>[p.id,p]));
     for(const[id,p]of before)if(!after.has(id))await recordPlaceChoice(c,{userId:req.user.id,place:p,kind:'edit',value:-1,tripId:t.id});
     for(const[id,p]of after)if(!before.has(id))await recordPlaceChoice(c,{userId:req.user.id,place:p,kind:'edit',value:1,tripId:t.id});
    }
    reason=b.operation.type==='apply_preview'?'采用已核验的局部方案':b.operation.type;
   }
   if(b.restoreVersion){
    const old=(await c.query('SELECT plan FROM trip_versions WHERE trip_id=$1 AND version=$2',[t.id,b.restoreVersion])).rows[0];if(!old)throw Object.assign(Error('版本不存在'),{status:404});
    plan=old.plan;await c.query("DELETE FROM user_place_style_choices WHERE user_id=$1 AND trip_id=$2 AND kind='edit'",[req.user.id,t.id]);reason='恢复版本 '+b.restoreVersion;
   }
   await c.query('INSERT INTO trip_versions(trip_id,version,plan,reason) VALUES($1,$2,$3,$4)',[t.id,t.version+1,JSON.stringify(plan),reason]);
   return (await c.query('UPDATE trips SET plan=$1,version=version+1,status=$2,updated_at=now() WHERE id=$3 RETURNING *',[JSON.stringify(plan),b.status||t.status,t.id])).rows[0];
  });res.json(result);
 };
}
