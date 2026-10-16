import {z} from 'zod';
import {requireManagement} from './permissions.mjs';
import {requireVisiblePost} from '../services/community-interactions.mjs';
const fail=(msg,status=400)=>Object.assign(Error(msg),{status});
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(30),offset:z.coerce.number().int().min(0).max(10000).default(0)});
const reasons=z.enum(['spam','abuse','inaccurate','other']);
export function installModeration(app,{query,transaction,events,auth}){
  const audit=(req,action,id,metadata={},c)=>events.append({userId:req.user.id,kind:'admin',action,resourceId:id,requestId:req.operationRequestId,metadata},c);
  app.get('/api/admin/content',requireManagement,async(req,res)=>{
    const {limit,offset}=paging.parse(req.query),kind=z.enum(['posts','comments']).default('posts').parse(req.query.kind),state=z.enum(['all','visible','hidden']).default('all').parse(req.query.state),q=z.string().trim().max(80).default('').parse(req.query.q).replace(/[\\%_]/g,'\\$&');
    const rows=(await query(`SELECT c.id,c.user_id,u.username,${kind==='posts'?'c.title,c.auto_shared':'c.post_id'},left(c.body,400) excerpt,c.hidden_at,c.moderation_version,c.created_at,
      (SELECT count(*)::int FROM content_reports r WHERE r.${kind==='posts'?'post_id':'comment_id'}=c.id AND r.state='open') open_reports
      FROM ${kind} c JOIN users u ON u.id=c.user_id WHERE (c.body ILIKE $1 OR u.username ILIKE $1 ${kind==='posts'?'OR c.title ILIKE $1':''}) AND ($2='all' OR ($2='hidden' AND c.hidden_at IS NOT NULL) OR ($2='visible' AND c.hidden_at IS NULL))
      ORDER BY c.created_at DESC,c.id DESC LIMIT $3 OFFSET $4`,['%'+q+'%',state,limit+1,offset])).rows;
    await audit(req,'content.list_read',kind);res.json({kind,items:rows.slice(0,limit),hasMore:rows.length>limit});
  });
  app.get('/api/admin/content/:kind/:id',requireManagement,async(req,res)=>{
    const kind=z.enum(['posts','comments']).parse(req.params.kind),id=z.uuid().parse(req.params.id);
    const p=(await query(`SELECT c.id,c.user_id,u.username,c.body,${kind==='posts'?'c.title,c.auto_shared':'c.post_id'},c.hidden_at,c.moderation_version,c.created_at FROM ${kind} c JOIN users u ON u.id=c.user_id WHERE c.id=$1`,[id])).rows[0];if(!p)throw fail('内容不存在',404);
    await audit(req,'content.read',id);res.json({kind,item:p});
  });
  app.patch('/api/admin/content/:kind/:id/visibility',requireManagement,async(req,res)=>{
    const kind=z.enum(['posts','comments']).parse(req.params.kind),id=z.uuid().parse(req.params.id),b=z.object({hidden:z.boolean(),version:z.number().int().positive(),reason:reasons,confirmation:z.literal('change-visibility')}).strict().parse(req.body);
    const result=await transaction(async c=>{const p=(await c.query(`SELECT id,hidden_at,moderation_version FROM ${kind} WHERE id=$1 FOR UPDATE`,[id])).rows[0];if(!p)throw fail('内容不存在',404);
      if(p.moderation_version!==b.version)throw fail('内容已被其他管理员处理，请刷新',409);if(!!p.hidden_at===b.hidden)return p;
      const row=(await c.query(`UPDATE ${kind} SET hidden_at=CASE WHEN $2 THEN now() ELSE NULL END,moderation_version=moderation_version+1 WHERE id=$1 RETURNING id,hidden_at,moderation_version`,[id,b.hidden])).rows[0];
      await audit(req,'content.visibility',id,{kind,hidden:b.hidden,reason:b.reason,version:row.moderation_version},c);return row;});res.json(result);
  });
  app.post('/api/content/reports',auth,async(req,res)=>{
    const b=z.object({id:z.uuid(),kind:z.enum(['posts','comments']),targetId:z.uuid(),reason:reasons}).strict().parse(req.body);
    const r=await transaction(async c=>{
      // Serialize this user's report submissions to make simultaneous duplicates deterministic.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[req.user.id]);
      const old=(await c.query('SELECT * FROM content_reports WHERE id=$1',[b.id])).rows[0];
      const column=b.kind==='posts'?'post_id':'comment_id';
      if(old){if(old.reporter_id!==req.user.id||old[column]!==b.targetId||old.reason!==b.reason)throw fail('报告编号已使用',409);return old;}
      if(b.kind==='posts')await requireVisiblePost(c,b.targetId,true);
      else{const comment=(await c.query('SELECT post_id FROM comments WHERE id=$1 AND hidden_at IS NULL',[b.targetId])).rows[0];if(!comment)throw fail('评论不存在',404);await requireVisiblePost(c,comment.post_id,true);}
      const pending=(await c.query(`SELECT * FROM content_reports WHERE reporter_id=$1 AND ${column}=$2 AND state='open'`,[req.user.id,b.targetId])).rows[0];if(pending)return pending;
      return (await c.query(`INSERT INTO content_reports(id,reporter_id,${column},reason) VALUES($1,$2,$3,$4) RETURNING *`,[b.id,req.user.id,b.targetId,b.reason])).rows[0];
    });res.status(201).json({id:r.id,state:r.state});
  });
  app.get('/api/admin/content-reports',requireManagement,async(req,res)=>{
    const {limit,offset}=paging.parse(req.query),state=z.enum(['open','resolved','dismissed']).default('open').parse(req.query.state);
    const rows=(await query(`SELECT r.id,r.post_id,r.comment_id,r.reason,r.state,r.version,r.created_at,r.resolved_at,u.username reporter
      FROM content_reports r LEFT JOIN users u ON u.id=r.reporter_id WHERE r.state=$1 ORDER BY r.created_at DESC,r.id LIMIT $2 OFFSET $3`,[state,limit+1,offset])).rows;
    await audit(req,'content.reports_read',state);res.json({items:rows.slice(0,limit),hasMore:rows.length>limit});
  });
  app.patch('/api/admin/content-reports/:id',requireManagement,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),b=z.object({state:z.enum(['resolved','dismissed']),version:z.number().int().positive(),confirmation:z.literal('resolve-report')}).strict().parse(req.body);
    const row=await transaction(async c=>{const r=(await c.query('SELECT * FROM content_reports WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!r)throw fail('报告不存在',404);if(r.version!==b.version||r.state!=='open')throw fail('报告已处理，请刷新',409);
      const result=(await c.query('UPDATE content_reports SET state=$2,version=version+1,resolved_at=now(),resolved_by=$3 WHERE id=$1 RETURNING id,state,version',[id,b.state,req.user.id])).rows[0];await audit(req,'content.report_resolved',id,{state:b.state},c);return result;});res.json(row);
  });
}
