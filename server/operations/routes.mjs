import {z} from 'zod';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
const compress=promisify(gzip);
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export const requireAdmin=(req,res,next)=>req.user?.role==='admin'&&!req.user.disabled_at?next():res.status(403).json({error:'需要管理员权限'});
const pagination=z.object({limit:z.coerce.number().int().min(1).max(100).default(30),offset:z.coerce.number().int().min(0).max(100000).default(0)});
const pages=['home','citywalk','services','agent','profile','account','history','settings','messages','favorites','browsing','report','discover'];
export function eventFilters(input, now=new Date()) {
  const v=z.object({from:z.iso.date().optional(),to:z.iso.date().optional(),userId:z.uuid().optional(),kind:z.enum(['request','navigation','admin','system']).optional()}).parse(input);
  const end=v.to?new Date(v.to+'T00:00:00+08:00').getTime()+86400000:now.getTime()+1;
  const start=v.from?new Date(v.from+'T00:00:00+08:00').getTime():end-7*86400000;
  if(end<=start||end-start>31*86400000)throw fail('请选择不超过 31 天的有效日期范围');
  return [new Date(start).toISOString(),new Date(end).toISOString(),v.userId||null,v.kind||null];
}
const where='e.created_at >= $1 AND e.created_at < $2 AND ($3::uuid IS NULL OR e.user_id=$3) AND ($4::text IS NULL OR e.kind=$4)';
export function installOperationsRoutes(app,{auth,query,transaction,events}) {
  app.post('/api/activity',auth,async(req,res)=>{
    const b=z.object({page:z.enum(pages),action:z.enum(['open','select','save','cancel']).default('open')}).strict().parse(req.body);
    events.record({userId:req.user.id,kind:'navigation',action:b.page+'.'+b.action,requestId:req.operationRequestId});
    res.status(202).json({accepted:true});
  });
  app.get('/api/admin/overview',auth,requireAdmin,async(req,res)=>{
    const counts=(await query(`SELECT (SELECT count(*)::int FROM users) users,
      (SELECT count(*)::int FROM users WHERE disabled_at IS NOT NULL) disabled,
      (SELECT count(*)::int FROM operation_events WHERE created_at>now()-interval '24 hours') events,
      (SELECT count(*)::int FROM operation_events WHERE kind='system' AND created_at>now()-interval '24 hours') errors`)).rows[0];
    res.json({counts,health:{database:'connected',uptimeSeconds:Math.floor(process.uptime()),rssMB:Math.round(process.memoryUsage().rss/1048576)},logs:events.stats()});
  });
  app.get('/api/admin/users',auth,requireAdmin,async(req,res)=>{
    const {limit,offset}=pagination.parse(req.query),q=z.string().trim().max(80).default('').parse(req.query.q);
    const state=z.enum(['all','active','disabled']).default('all').parse(req.query.state),role=z.enum(['all','user','admin']).default('all').parse(req.query.role);
    const filter=q.replace(/[\\%_]/g,'\\$&');
    const rows=(await query(`SELECT id,username,nickname,role,disabled_at,created_at FROM users
      WHERE (username ILIKE $1 OR nickname ILIKE $1) AND ($4='all' OR ($4='active' AND disabled_at IS NULL) OR ($4='disabled' AND disabled_at IS NOT NULL))
      AND ($5='all' OR role=$5) ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`,['%'+filter+'%',limit+1,offset,state,role])).rows;
    res.json({items:rows.slice(0,limit),hasMore:rows.length>limit});
  });
  app.get('/api/admin/users/:id',auth,requireAdmin,async(req,res)=>{
    const id=z.uuid().parse(req.params.id);
    const user=(await query(`SELECT u.id,u.username,u.nickname,u.role,u.disabled_at,u.created_at,u.password_changed_at,
      EXISTS(SELECT 1 FROM user_emails m WHERE m.user_id=u.id) email_verified,
      (SELECT count(*)::int FROM operation_events e WHERE e.user_id=u.id) operation_count,
      (SELECT max(created_at) FROM operation_events e WHERE e.user_id=u.id) last_operation_at
      FROM users u WHERE u.id=$1`,[id])).rows[0];
    if(!user)throw fail('用户不存在',404);
    const sessions=(await query('SELECT created_at,expires_at FROM sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 101',[id])).rows;
    res.json({user,sessions:sessions.slice(0,100),hasMoreSessions:sessions.length>100});
  });
  app.post('/api/admin/users/:id/sessions/revoke',auth,requireAdmin,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),b=z.object({confirmation:z.literal('revoke'),reason:z.enum(['support','security','requested'])}).strict().parse(req.body);
    const result=await transaction(async c=>{
      const u=(await c.query('SELECT id,role FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!u)throw fail('用户不存在',404);
      if(u.role==='admin'||id===req.user.id)throw fail('管理员会话须由账号本人或服务器维护工具处理',409);
      const r=await c.query('DELETE FROM sessions WHERE user_id=$1',[id]);
      if(r.rowCount)await events.append({userId:req.user.id,kind:'admin',action:'user.revoke_sessions',resourceId:id,requestId:req.operationRequestId,metadata:{reason:b.reason,sessions:r.rowCount}},c);
      return {revoked:r.rowCount};
    });res.json(result);
  });
  app.patch('/api/admin/users/:id/status',auth,requireAdmin,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),b=z.object({disabled:z.boolean(),reason:z.enum(['support','security','requested'])}).strict().parse(req.body);
    if(id===req.user.id)throw fail('不能禁用自己的账号',409);
    const user=await transaction(async c=>{
      const u=(await c.query('SELECT id,username,role,disabled_at FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!u)throw fail('用户不存在',404);
      if(u.role==='admin')throw fail('管理员账号须通过服务器维护工具处理',409);
      await c.query('UPDATE users SET disabled_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1',[id,b.disabled]);
      if(b.disabled)await c.query('DELETE FROM sessions WHERE user_id=$1',[id]);
      await events.append({userId:req.user.id,kind:'admin',action:b.disabled?'user.disable':'user.enable',resourceId:id,requestId:req.operationRequestId,metadata:{reason:b.reason}},c);
      return {id:u.id,username:u.username,disabled:b.disabled};
    });
    res.json(user);
  });
  app.get('/api/admin/events',auth,requireAdmin,async(req,res)=>{
    const {limit,offset}=pagination.parse(req.query),filters=eventFilters(req.query);
    const rows=(await query(`SELECT e.*,u.username FROM operation_events e LEFT JOIN users u ON u.id=e.user_id WHERE ${where} ORDER BY e.created_at DESC,e.id DESC LIMIT $5 OFFSET $6`,[...filters,limit+1,offset])).rows;
    res.json({items:rows.slice(0,limit),hasMore:rows.length>limit});
  });
  app.get('/api/admin/events/export',auth,requireAdmin,async(req,res)=>{
    const filters=eventFilters(req.query);
    const rows=(await query(`SELECT e.*,u.username FROM operation_events e LEFT JOIN users u ON u.id=e.user_id WHERE ${where} ORDER BY e.created_at,e.id LIMIT 20001`,filters)).rows;
    if(rows.length>20000)throw fail('日志超过 20,000 条，请缩小日期范围后导出',413);
    const data=await compress(Buffer.from(rows.map(r=>JSON.stringify(r)).join('\n')+'\n'));
    await events.append({userId:req.user.id,kind:'admin',action:'logs.export',requestId:req.operationRequestId,metadata:{from:filters[0],to:filters[1],rows:rows.length}});
    res.set({'Content-Type':'application/gzip','Content-Disposition':'attachment; filename="seatraces-operations.log.gz"','Cache-Control':'no-store'}).send(data);
  });
  app.get('/api/admin/tasks',auth,requireAdmin,async(req,res)=>{
    const rows=(await query('SELECT id,source,rows_count,status,created_at FROM import_jobs ORDER BY created_at DESC LIMIT 50')).rows;
    res.json({items:rows});
  });
  app.get('/api/admin/events/:id',auth,requireAdmin,async(req,res)=>{
    const id=z.string().regex(/^[1-9]\d{0,17}$/).parse(req.params.id);
    const row=(await query('SELECT e.*,u.username FROM operation_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.id=$1',[id])).rows[0];
    if(!row)throw fail('日志不存在',404);res.json(row);
  });
}
