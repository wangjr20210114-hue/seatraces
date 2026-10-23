/* 保存和读取后台日志查询视图。 */

import {z} from 'zod';
import {logFilterSchema,logColumns,eventFilters} from './event-query.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const input=z.object({id:z.uuid(),name:z.string().trim().min(1).max(50),filters:logFilterSchema.strict(),
  columns:z.array(z.enum(logColumns)).min(1).max(logColumns.length).refine(v=>new Set(v).size===v.length),version:z.number().int().positive().optional()}).strict();
export function installLogViews(app,{query,transaction,events}){
  app.get('/api/admin/events/views',async(req,res)=>res.json({items:(await query('SELECT id,name,filters,columns,version,updated_at FROM admin_log_views WHERE owner_id=$1 ORDER BY updated_at DESC,id',[req.user.id])).rows}));
  app.put('/api/admin/events/views/:id',async(req,res)=>{
    const b=input.parse(req.body);if(b.id!==req.params.id)throw fail('视图编号不一致');eventFilters(b.filters);
    const result=await transaction(async c=>{
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['log-views:'+req.user.id]);
      const old=(await c.query('SELECT * FROM admin_log_views WHERE id=$1 FOR UPDATE',[b.id])).rows[0];
      if(old&&old.owner_id!==req.user.id)throw fail('视图不存在',404);
      if(old&&old.version!==b.version)throw fail('视图已变化，请重新加载',409);
      if(!old&&b.version)throw fail('视图不存在',404);
      if(!old&&(await c.query('SELECT count(*)::int n FROM admin_log_views WHERE owner_id=$1',[req.user.id])).rows[0].n>=20)throw fail('最多保存 20 个视图，请先删除不再使用的视图',409);
      if((await c.query('SELECT 1 FROM admin_log_views WHERE owner_id=$1 AND name=$2 AND id<>$3',[req.user.id,b.name,b.id])).rowCount)throw fail('已有同名视图',409);
      const r=(await c.query(`INSERT INTO admin_log_views(id,owner_id,name,filters,columns) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(id) DO UPDATE SET name=$3,filters=$4,columns=$5,version=admin_log_views.version+1,updated_at=now()
        RETURNING id,name,filters,columns,version,updated_at`,[b.id,req.user.id,b.name,b.filters,JSON.stringify(b.columns)])).rows[0];
      await events.append({userId:req.user.id,kind:'admin',action:old?'log_view.update':'log_view.create',resourceId:b.id,requestId:req.operationRequestId},c);return r;
    });res.json(result);
  });
  app.delete('/api/admin/events/views/:id',async(req,res)=>{
    const id=z.uuid().parse(req.params.id),b=z.object({version:z.number().int().positive(),confirmation:z.literal('delete-view')}).strict().parse(req.body);
    await transaction(async c=>{
      const row=(await c.query('SELECT version FROM admin_log_views WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,req.user.id])).rows[0];
      if(!row)throw fail('视图不存在',404);if(row.version!==b.version)throw fail('视图已变化，请重新加载',409);
      await c.query('DELETE FROM admin_log_views WHERE id=$1 AND owner_id=$2',[id,req.user.id]);
      await events.append({userId:req.user.id,kind:'admin',action:'log_view.delete',resourceId:id,requestId:req.operationRequestId},c);
    });res.json({ok:true});
  });
}
