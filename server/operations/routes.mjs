import {streamLegacyLogs,createLogExportService} from './log-export.mjs';
import {createAdminActionRunner} from './action-runner.mjs';
import {eventFilters,eventQuery} from './event-query.mjs';
export {eventFilters} from './event-query.mjs';
import {installLogViews} from './log-views.mjs';
import {z} from 'zod';
import {requireManagement,can} from './permissions.mjs';
import {requireRawCoverage,archivedUserStats,archivedEvent,latestTime} from './archive-coverage.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export const requireAdmin=requireManagement;
const pagination=z.object({limit:z.coerce.number().int().min(1).max(100).default(30),offset:z.coerce.number().int().min(0).max(100000).default(0)});
const pages=['home','citywalk','services','agent','profile','account','history','settings','messages','favorites','browsing','report','discover'];
export function installOperationsRoutes(app,{auth,query,transaction,events}) {
  const logExports=createLogExportService({query,transaction,events});
  logExports.install(app);
  installLogViews(app,{query,transaction,events});
  const runAction=createAdminActionRunner({transaction,events});
  app.get('/api/admin/cities',auth,requireAdmin,async(req,res)=>{
    const q=z.string().trim().max(100).default('').parse(req.query.q).replace(/[\\%_]/g,'\\$&');
    res.json((await query("SELECT id,name,province,country FROM places WHERE category='city' AND name ILIKE $1 ORDER BY name,id LIMIT 10",['%'+q+'%'])).rows);
  });
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
    res.json({counts,...(can(req.adminAccess,'system.read')?{health:{database:'connected',uptimeSeconds:Math.floor(process.uptime()),rssMB:Math.round(process.memoryUsage().rss/1048576)},logs:events.stats()}:{})});
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
    const archived=await archivedUserStats(query,id);
    user.operation_count+=archived.count;user.last_operation_at=latestTime(user.last_operation_at,archived.last_at);
    user.archived_operation_count=archived.count;
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
    const user=await runAction(req,'user.status',async({c,b,id})=>{
      if(id===req.user.id)throw fail('不能禁用自己的账号',409);
      const u=(await c.query('SELECT id,username,role,disabled_at FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!u)throw fail('用户不存在',404);
      if(u.role==='admin')throw fail('管理员账号须通过服务器维护工具处理',409);
      const value={id:u.id,username:u.username,disabled:b.disabled};
      if(Boolean(u.disabled_at)===b.disabled)return {value,changed:false};
      await c.query('UPDATE users SET disabled_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1',[id,b.disabled]);
      if(b.disabled)await c.query('DELETE FROM sessions WHERE user_id=$1',[id]);
      return {value,metadata:{reason:b.reason}};
    });
    res.json(user);
  });
  app.get('/api/admin/events',auth,requireAdmin,async(req,res)=>{
    const {limit,offset}=pagination.parse(req.query),selection=eventQuery(req.query),filters=selection.values;
    const rows=(await query(`SELECT e.*,u.username FROM operation_events e LEFT JOIN users u ON u.id=e.user_id WHERE ${selection.where} ORDER BY ${selection.order} LIMIT $${filters.length+1} OFFSET $${filters.length+2}`,[...filters,limit+1,offset])).rows;
    await requireRawCoverage(query,filters[0],filters[1],{stream:'operation',userId:filters[2]});
    res.json({items:rows.slice(0,limit),hasMore:rows.length>limit});
  });
  app.get('/api/admin/events/export',auth,requireAdmin,async(req,res)=>{
    await streamLegacyLogs(req,res,{query,events});
  });
  app.get('/api/admin/tasks',auth,requireAdmin,async(req,res)=>{
    const rows=(await query('SELECT id,source,rows_count,status,created_at FROM import_jobs ORDER BY created_at DESC LIMIT 50')).rows;
    res.json({items:rows});
  });
  app.get('/api/admin/events/:id',auth,requireAdmin,async(req,res)=>{
    const id=z.string().regex(/^[1-9]\d{0,17}$/).parse(req.params.id);
    const row=(await query('SELECT e.*,u.username FROM operation_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.id=$1',[id])).rows[0];
    if(!row){if(await archivedEvent(query,id))throw fail('该日志已归档，请先恢复对应归档包',409);throw fail('日志不存在',404);}res.json(row);
  });
  return logExports;
}
