/* 提供站内信编辑、发送、阅读和未读查询接口。 */

import {createAdminActionRunner} from './action-runner.mjs';
import {z} from 'zod';
import {requireAdmin} from './routes.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const draft=z.object({id:z.uuid(),title:z.string().trim().min(1).max(80),body:z.string().trim().min(1).max(4000),audience:z.enum(['all','selected']),recipientIds:z.array(z.uuid()).max(500).default([])}).strict().superRefine((v,ctx)=>{
  if(v.audience==='selected'&&!v.recipientIds.length)ctx.addIssue({code:'custom',message:'请选择收件人'});
  if(v.audience==='all'&&v.recipientIds.length)ctx.addIssue({code:'custom',message:'全体用户无需指定收件人'});
  if(new Set(v.recipientIds).size!==v.recipientIds.length)ctx.addIssue({code:'custom',message:'收件人重复'});
});
const page=z.object({limit:z.coerce.number().int().min(1).max(100).default(30),offset:z.coerce.number().int().min(0).max(100000).default(0)});
const audienceWhere="disabled_at IS NULL AND ($1='all' OR id=ANY($2::uuid[])) AND NOT(role='admin' AND username ~ '^demo_[a-f0-9]{8}$')";
export function installInboxRoutes(app,{auth,query,transaction,events}) {
  const runAction=createAdminActionRunner({transaction,events});
  const ownDraft=async(id,user,c={query},lock=false)=>{
    const row=(await c.query('SELECT * FROM inbox_campaigns WHERE id=$1 AND created_by=$2'+(lock?' FOR UPDATE':''),[z.uuid().parse(id),user])).rows[0];
    if(!row)throw fail('消息不存在',404);return row;
  };
  const audienceCount=async(row,c={query})=>(await c.query(`SELECT count(*)::int n FROM users WHERE ${audienceWhere}`,[row.audience,row.recipient_ids])).rows[0].n;
  app.get('/api/admin/messages',auth,requireAdmin,async(req,res)=>{
    const {limit,offset}=page.parse(req.query);
    const rows=(await query(`SELECT c.*, (SELECT count(*)::int FROM inbox_messages m WHERE m.campaign_id=c.id AND m.read_at IS NOT NULL) read_count FROM inbox_campaigns c WHERE c.created_by=$1 ORDER BY c.created_at DESC,c.id LIMIT $2 OFFSET $3`,[req.user.id,limit+1,offset])).rows;
    res.json({items:rows.slice(0,limit),hasMore:rows.length>limit,externalEmail:{enabled:false,status:'reserved'}});
  });
  app.post('/api/admin/messages',auth,requireAdmin,async(req,res)=>{
    const b=draft.parse(req.body);
    const value=await transaction(async c=>{
      const inserted=(await c.query(`INSERT INTO inbox_campaigns(id,created_by,title,body,audience,recipient_ids) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING *`,[b.id,req.user.id,b.title,b.body,b.audience,b.recipientIds])).rows[0];
      if(!inserted){const old=await ownDraft(b.id,req.user.id,c);if(old.title!==b.title||old.body!==b.body||old.audience!==b.audience||JSON.stringify([...old.recipient_ids].sort())!==JSON.stringify([...b.recipientIds].sort()))throw fail('提交编号已用于其他消息',409);return old;}
      const n=await audienceCount(inserted,c);if(b.audience==='selected'&&n!==b.recipientIds.length)throw fail('包含不存在或已停用的收件人');
      await events.append({userId:req.user.id,kind:'admin',action:'message.draft',resourceId:b.id,requestId:req.operationRequestId},c);
      return inserted;
    });res.status(201).json(value);
  });
  app.get('/api/admin/messages/:id/preview',auth,requireAdmin,async(req,res)=>{
    const row=await ownDraft(req.params.id,req.user.id);
    const recipients=row.audience==='selected'?(await query('SELECT id,username,nickname FROM users WHERE id=ANY($1::uuid[])',[row.recipient_ids])).rows:[];
    res.json({...row,recipients,eligibleRecipients:await audienceCount(row)});
  });
  app.put('/api/admin/messages/:id',auth,requireAdmin,async(req,res)=>{
    const {version,...data}=z.object({version:z.number().int().positive()}).passthrough().parse(req.body),b=draft.parse(data);
    if(b.id!==req.params.id)throw fail('消息编号不一致');
    const row=await transaction(async c=>{
      const old=await ownDraft(b.id,req.user.id,c,true);
      if(old.status!=='draft'||old.version!==version)throw fail('草稿已变化，请重新打开',409);
      const n=await audienceCount({audience:b.audience,recipient_ids:b.recipientIds},c);if(b.audience==='selected'&&n!==b.recipientIds.length)throw fail('包含不存在或已停用的收件人');
      const updated=(await c.query('UPDATE inbox_campaigns SET title=$2,body=$3,audience=$4,recipient_ids=$5,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[b.id,b.title,b.body,b.audience,b.recipientIds])).rows[0];
      await events.append({userId:req.user.id,kind:'admin',action:'message.edit',resourceId:b.id},c);return updated;
    });res.json(row);
  });
  app.post('/api/admin/messages/:id/send',auth,requireAdmin,async(req,res)=>{
    const row=await runAction(req,'message.send',async({c,b})=>{
      const row=await ownDraft(req.params.id,req.user.id,c,true);
      if(row.status==='sent')return {value:row,changed:false};
      if(row.status!=='draft'||row.version!==b.version)throw fail('消息状态已变化，请重新预览',409);
      const delivery=(await c.query(`WITH targets AS MATERIALIZED(SELECT id FROM users WHERE ${audienceWhere} ORDER BY id FOR SHARE),
        delivered AS (INSERT INTO inbox_messages(campaign_id,user_id) SELECT $3,id FROM targets ON CONFLICT(campaign_id,user_id) DO NOTHING RETURNING 1)
        SELECT (SELECT count(*)::int FROM targets) recipients,(SELECT count(*)::int FROM delivered) inserted`,[row.audience,row.recipient_ids,row.id])).rows[0];
      if(!delivery.recipients||delivery.recipients!==b.recipientCount)throw fail('收件人数已变化，请重新预览后发送',409);
      const sent=(await c.query("UPDATE inbox_campaigns SET status='sent',recipient_count=$2,sent_at=now(),updated_at=now(),version=version+1 WHERE id=$1 RETURNING *",[row.id,delivery.recipients])).rows[0];
      return {value:sent,metadata:{recipients:delivery.recipients,channel:'in_app'}};
    });res.json(row);
  });
  app.post('/api/admin/messages/:id/cancel',auth,requireAdmin,async(req,res)=>{
    z.object({}).strict().parse(req.body);
    const row=await transaction(async c=>{const row=await ownDraft(req.params.id,req.user.id,c,true);if(row.status==='sent')throw fail('已发送消息不能取消',409);if(row.status==='cancelled')return row;const result=(await c.query("UPDATE inbox_campaigns SET status='cancelled',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0];await events.append({userId:req.user.id,kind:'admin',action:'message.cancel',resourceId:row.id},c);return result;});res.json(row);
  });
  app.get('/api/me/messages',auth,async(req,res)=>{
    const {limit,offset}=page.parse(req.query);
    const unreadOnly=z.enum(['0','1']).optional().parse(req.query.unread)==='1';
    const rows=(await query(`SELECT m.id,c.title,m.created_at,m.read_at FROM inbox_messages m JOIN inbox_campaigns c ON c.id=m.campaign_id WHERE m.user_id=$1 AND ($4::boolean=false OR m.read_at IS NULL) ORDER BY m.created_at DESC,m.id DESC LIMIT $2 OFFSET $3`,[req.user.id,limit+1,offset,unreadOnly])).rows;
    const unread=(await query('SELECT count(*)::int n FROM inbox_messages WHERE user_id=$1 AND read_at IS NULL',[req.user.id])).rows[0].n;
    res.set('Cache-Control','no-store').json({items:rows.slice(0,limit),hasMore:rows.length>limit,unread,userId:req.user.id});
  });
  app.get('/api/me/messages/:id',auth,async(req,res)=>{
    const row=(await query('SELECT m.id,c.title,c.body,m.created_at,m.read_at FROM inbox_messages m JOIN inbox_campaigns c ON c.id=m.campaign_id WHERE m.id=$1 AND m.user_id=$2',[z.uuid().parse(req.params.id),req.user.id])).rows[0];if(!row)throw fail('消息不存在',404);res.json(row);
  });
  app.post('/api/me/messages/:id/read',auth,async(req,res)=>{
    z.object({}).strict().parse(req.body);
    const r=await query('UPDATE inbox_messages SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at',[z.uuid().parse(req.params.id),req.user.id]);if(!r.rowCount)throw fail('消息不存在',404);res.json(r.rows[0]);
  });
}
