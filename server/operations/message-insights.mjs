import {z} from 'zod';
import {requireManagement} from './permissions.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const segments={new:'近 7 天注册',active:'近 7 天活跃',inactive:'近 30 天无已记录活动',planners:'已有行程',walkers:'已有 CityWalk'};
export function installMessageInsights(app,{query,events}){
  const audit=(req,action,resourceId)=>events.append({userId:req.user.id,kind:'admin',action,resourceId,requestId:req.operationRequestId});
  app.get('/api/admin/messages/audience',requireManagement,async(req,res)=>{
    const segment=z.enum(['new','active','inactive','planners','walkers']).parse(req.query.segment);
    // Fixed SQL predicates only. The result is an explicit recipient snapshot;
    // normal draft preview and send confirmation still apply afterwards.
    const active=`(EXISTS(SELECT 1 FROM product_events e WHERE e.user_id=u.id AND e.created_at>=now()-interval '7 days') OR EXISTS(SELECT 1 FROM operation_events e WHERE e.user_id=u.id AND e.kind='navigation' AND e.created_at>=now()-interval '7 days'))`;
    const predicates={new:"u.created_at>=now()-interval '7 days'",active,inactive:"u.created_at<now()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM product_events e WHERE e.user_id=u.id AND e.created_at>=now()-interval '30 days') AND NOT EXISTS(SELECT 1 FROM operation_events e WHERE e.user_id=u.id AND e.kind='navigation' AND e.created_at>=now()-interval '30 days')",planners:'EXISTS(SELECT 1 FROM trips t WHERE t.user_id=u.id)',walkers:'EXISTS(SELECT 1 FROM citywalks t WHERE t.user_id=u.id)'};
    const items=(await query(`SELECT id,username,nickname FROM users u WHERE u.role='user' AND NOT u.analytics_excluded AND u.disabled_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM admin_memberships m WHERE m.user_id=u.id AND m.enabled) AND ${predicates[segment]} ORDER BY username,id LIMIT 501`)).rows;
    if(items.length>500)throw fail('该分群超过 500 人，请缩小为指定收件人；未截断或发送',422);
    await audit(req,'message.audience_read',segment);res.json({segment,label:segments[segment],items,asOf:new Date().toISOString(),snapshot:true,definition:'当前有效正式用户；后台人员和已标记测试账号排除。活跃依据已记录页面行为与业务事件；无记录不等于确定未使用。'});
  });
  app.get('/api/admin/messages/:id/effects',requireManagement,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),v=z.object({state:z.enum(['all','read','unread']).default('all'),limit:z.coerce.number().int().min(1).max(100).default(30),offset:z.coerce.number().int().min(0).max(10000).default(0)}).parse(req.query);
    const c=(await query('SELECT id,title,status,sent_at,recipient_count FROM inbox_campaigns WHERE id=$1 AND created_by=$2',[id,req.user.id])).rows[0];if(!c)throw fail('消息不存在',404);
    const totals=(await query(`SELECT count(*)::int stored,count(*) FILTER(WHERE read_at IS NOT NULL)::int read,
      count(*) FILTER(WHERE read_at IS NULL)::int unread,min(read_at) first_read_at,max(read_at) last_read_at
      FROM inbox_messages WHERE campaign_id=$1`,[id])).rows[0];
    const items=(await query(`SELECT m.id,u.username,u.nickname,m.created_at,m.read_at FROM inbox_messages m JOIN users u ON u.id=m.user_id
      WHERE m.campaign_id=$1 AND ($2='all' OR ($2='read' AND m.read_at IS NOT NULL) OR ($2='unread' AND m.read_at IS NULL))
      ORDER BY m.created_at DESC,m.id DESC LIMIT $3 OFFSET $4`,[id,v.state,v.limit+1,v.offset])).rows;
    const daily=(await query("SELECT (read_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day,count(*)::int first_reads FROM inbox_messages WHERE campaign_id=$1 AND read_at>=((date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai')-interval '30 days') AT TIME ZONE 'Asia/Shanghai') GROUP BY 1 ORDER BY 1",[id])).rows;
    await audit(req,'message.effects_read',id);res.json({campaign:c,totals:{...totals,removedRecipientRecords:Math.max(0,c.recipient_count-totals.stored),readRate:totals.stored?Math.round(totals.read/totals.stored*10000)/100:null},daily,items:items.slice(0,v.limit),hasMore:items.length>v.limit,asOf:new Date().toISOString(),definition:'送达为站内信写入成功，不表示外部邮件送达或已看到通知。已读率以仍保留的收件记录为分母；阅读趋势仅展示最近 31 天的首次阅读。无点击转化采集，不推断转化效果。'});
  });
}
