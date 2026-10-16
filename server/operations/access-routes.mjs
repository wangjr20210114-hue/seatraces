import {z} from 'zod';
import {roles,requireManagement} from './permissions.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export function installAccessRoutes(app,{query,transaction,events}) {
  app.get('/api/admin/access',requireManagement,(req,res)=>res.json({access:req.adminAccess,roles}));
  app.get('/api/admin/access/members',requireManagement,async(req,res)=>{
    const q=z.string().trim().max(80).default('').parse(req.query.q).replace(/[\\%_]/g,'\\$&');
    const offset=z.coerce.number().int().min(0).max(100000).default(0).parse(req.query.offset);
    const rows=(await query(`SELECT u.id,u.username,u.nickname,u.role account_role,u.disabled_at,
      m.role,m.enabled,COALESCE(m.version,0) version,m.updated_at
      FROM users u LEFT JOIN admin_memberships m ON m.user_id=u.id
      WHERE (u.username ILIKE $1 OR u.nickname ILIKE $1)
      AND ($2 OR u.role='admin' OR m.user_id IS NOT NULL)
      ORDER BY u.username,u.id LIMIT 31 OFFSET $3`,['%'+q+'%',!!q,offset])).rows;
    res.json({items:rows.slice(0,30),hasMore:rows.length>30});
  });
  app.put('/api/admin/access/members/:id',requireManagement,async(req,res)=>{
    const id=z.uuid().parse(req.params.id);
    const b=z.object({role:z.enum(['operator','support','analyst']).nullable(),version:z.number().int().min(0),confirmation:z.literal('change-role')}).strict().parse(req.body);
    const result=await transaction(async c=>{
      // Serialize against account disable, password reset and concurrent role edits.
      const u=(await c.query('SELECT id,role,disabled_at FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!u)throw fail('用户不存在',404);
      if(u.role==='admin'||id===req.user.id)throw fail('不能通过此接口修改管理员或自己的权限',409);
      if(u.disabled_at&&b.role)throw fail('停用用户不能获得后台权限',409);
      const old=(await c.query('SELECT * FROM admin_memberships WHERE user_id=$1',[id])).rows[0];
      if((old?.version||0)!==b.version)throw fail('权限已变更，请刷新后重试',409);
      if(!old&&!b.role)throw fail('该用户没有后台权限',409);
      const next=(await c.query(`INSERT INTO admin_memberships(user_id,role,enabled,updated_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,enabled=excluded.enabled,
        version=admin_memberships.version+1,updated_by=excluded.updated_by,updated_at=now()
        RETURNING role,enabled,version`,[id,b.role||old.role,!!b.role,req.user.id])).rows[0];
      await c.query('DELETE FROM sessions WHERE user_id=$1 AND admin_access_version IS NOT NULL',[id]);
      await events.append({userId:req.user.id,kind:'admin',action:'management.role_changed',resourceId:id,requestId:req.operationRequestId,
        metadata:{before:old?.enabled?old.role:null,after:next.enabled?next.role:null,version:next.version}},c);
      return next;
    });res.json(result);
  });
}
