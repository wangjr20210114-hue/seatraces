import {z} from 'zod';
import {requireManagement} from './permissions.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const dayMs=86400000;
export const chinaDate=d=>new Date(new Date(d).getTime()+8*3600000).toISOString().slice(0,10);
export function analyticsWindow(input,now=new Date()){
  const v=z.object({from:z.iso.date().optional(),to:z.iso.date().optional()}).parse(input);
  const today=chinaDate(now),to=v.to||today;
  const end=new Date(to+'T00:00:00+08:00').getTime()+dayMs;
  const from=v.from||chinaDate(end-7*dayMs),start=new Date(from+'T00:00:00+08:00').getTime();
  if(to>today||end<=start||end-start>31*dayMs)throw fail('请选择截至今天、不超过 31 天的日期范围');
  return {from,to,start:new Date(start).toISOString(),end:new Date(Math.min(end,now.getTime())).toISOString(),asOf:now.toISOString(),days:Math.round((end-start)/dayMs),timezone:'Asia/Shanghai'};
}
// Staff are excluded using current role assignments, never name guesses. A
// separate audited flag identifies genuine test accounts without deleting them.
const eligible=`eligible AS (SELECT id,created_at FROM users u WHERE u.role='user' AND NOT u.analytics_excluded AND u.created_at < $2::timestamptz
  AND NOT EXISTS(SELECT 1 FROM admin_memberships m WHERE m.user_id=u.id AND m.enabled))`;
const activity=`activity AS (
 SELECT user_id,created_at FROM product_events WHERE created_at >= $1 AND created_at < $2
 UNION ALL SELECT user_id,created_at FROM operation_events WHERE kind='navigation' AND created_at >= $1 AND created_at < $2
)`;
const series=`days AS (SELECT generate_series($3::date,$4::date,interval '1 day')::date AS day)`;
const rates=(n,d)=>d?Math.round(n/d*10000)/100:null;
const funnelSpecs={
  journey:{name:'个性化行程',types:['journey.started','journey.candidates_loaded','journey.questions_ready','journey.completed'],labels:['创建规划会话','候选已准备','个性化问题已准备','行程已保存'],key:'flow_id'},
  citywalk:{name:'自建 CityWalk',types:['citywalk.started','citywalk.saved'],labels:['创建路线草稿','路线已保存'],key:'flow_id'},
  agent:{name:'AI 操作',types:['agent.action_prepared','agent.action_executing','agent.action_completed'],labels:['操作已准备','开始执行','执行成功'],key:'resource_id'},
};
export function installAnalytics(app,{query,transaction,events,now=()=>new Date()}){
  const window=req=>analyticsWindow(req.query,now());
  async function coverage(w){
    const row=(await query('SELECT started_at,raw_retention_days,aggregate_retention_months FROM analytics_settings WHERE id=1')).rows[0];
    return {startedAt:row.started_at,partial:new Date(w.start)<new Date(row.started_at),definitions:{active:'登录用户当天至少有一次页面行为或可靠业务事件；后台人员和标记测试账号排除；心跳与纯接口读取不计入。',saved:'当前仍保存的业务记录，按创建日期统计；历史删除记录不补造。',scope:'正式旅行用户；停用账号的历史记录保留在统计中。'},historicalBackfill:false};
  }
  app.get('/api/admin/analytics/overview',requireManagement,async(req,res)=>{
    const w=window(req),args=[w.start,w.end,w.from,w.to];
    const rows=(await query(`WITH ${eligible},${activity},${series}, daily AS (
      SELECT (a.created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,count(DISTINCT a.user_id)::int active
      FROM activity a JOIN eligible u ON u.id=a.user_id GROUP BY 1
    ), registrations AS (SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,count(*)::int registered FROM eligible WHERE created_at >= $1 AND created_at < $2 GROUP BY 1),
    saved AS (SELECT (t.created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,count(*)::int trips FROM trips t JOIN eligible u ON u.id=t.user_id WHERE t.created_at >= $1 AND t.created_at < $2 GROUP BY 1),
    walks AS (SELECT (t.created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,count(*)::int walks FROM citywalks t JOIN eligible u ON u.id=t.user_id WHERE t.created_at >= $1 AND t.created_at < $2 GROUP BY 1)
    SELECT d.day::text,coalesce(a.active,0) active,coalesce(r.registered,0) registered,coalesce(s.trips,0) trips,coalesce(c.walks,0) walks
    FROM days d LEFT JOIN daily a USING(day) LEFT JOIN registrations r USING(day) LEFT JOIN saved s USING(day) LEFT JOIN walks c USING(day) ORDER BY d.day`,args)).rows;
    const totals=(await query(`WITH ${eligible},${activity} SELECT
      (SELECT count(*)::int FROM eligible) users,
      (SELECT count(DISTINCT a.user_id)::int FROM activity a JOIN eligible u ON u.id=a.user_id) active,
      (SELECT count(*)::int FROM eligible WHERE created_at >= $1 AND created_at < $2) registered,
      (SELECT count(*)::int FROM trips t JOIN eligible u ON u.id=t.user_id WHERE t.created_at >= $1 AND t.created_at < $2) trips,
      (SELECT count(*)::int FROM citywalks t JOIN eligible u ON u.id=t.user_id WHERE t.created_at >= $1 AND t.created_at < $2) walks`,args.slice(0,2))).rows[0];
    res.json({window:w,totals,series:rows,coverage:await coverage(w)});
  });
  app.get('/api/admin/analytics/funnels',requireManagement,async(req,res)=>{
    const w=window(req),kind=z.enum(['journey','citywalk','agent']).default('journey').parse(req.query.kind),spec=funnelSpecs[kind];
    // Ordered, same-user, same-flow steps; out-of-order and replay events cannot
    // inflate conversion. Late completions are allowed for seven days per start.
    let sql=`WITH ${eligible}, e AS NOT MATERIALIZED (SELECT p.* FROM product_events p JOIN eligible u ON u.id=p.user_id
      WHERE p.created_at >= $1 AND p.created_at <= $3 AND p.event_type=ANY($4::text[]) AND p.resource_type='${kind}'),
      step0 AS (SELECT user_id,${spec.key} flow,min(created_at) started,min(created_at) t0 FROM e
      WHERE event_type=$4[1] AND created_at < $2 AND ${spec.key} IS NOT NULL GROUP BY user_id,${spec.key})`;
    for(let i=1;i<spec.types.length;i++)sql+=`,step${i} AS (SELECT p.*,s.t${i} FROM step${i-1} p LEFT JOIN LATERAL
      (SELECT min(e.created_at) t${i} FROM e WHERE e.user_id=p.user_id AND e.${spec.key}=p.flow AND e.event_type=$4[${i+1}]
       AND e.created_at>=p.t${i-1} AND e.created_at<=p.started+interval '7 days') s ON true)`;
    sql+=` SELECT count(*)::int starts,count(*) FILTER(WHERE started+interval '7 days'<=$3)::int matured,
      ${spec.types.map((_,i)=>`count(t${i})::int n${i}`).join(',')} FROM step${spec.types.length-1}`;
    const row=(await query(sql,[w.start,w.end,w.asOf,spec.types])).rows[0];
    const steps=spec.types.map((event,i)=>({event,label:spec.labels[i],count:row['n'+i],conversion:rates(row['n'+i],row.n0),dropoff:i?row['n'+(i-1)]-row['n'+i]:0}));
    res.json({window:w,kind,name:spec.name,unit:kind==='agent'?'action':'flow',conversionWindowDays:7,maturedFlows:row.matured,observingFlows:row.starts-row.matured,steps,coverage:await coverage(w)});
  });
  app.get('/api/admin/analytics/retention',requireManagement,async(req,res)=>{
    const w=window(req),c=await coverage(w);
    const rows=(await query(`WITH ${eligible}, activity AS (
      SELECT user_id,(created_at AT TIME ZONE 'Asia/Shanghai')::date AS day FROM product_events WHERE created_at >= $1 AND created_at <= $2
      UNION SELECT user_id,(created_at AT TIME ZONE 'Asia/Shanghai')::date AS day FROM operation_events WHERE kind='navigation' AND created_at >= $1 AND created_at <= $2
    ),cohort AS (SELECT id,(created_at AT TIME ZONE 'Asia/Shanghai')::date AS day FROM eligible WHERE created_at >= $1 AND created_at < $3)
    SELECT c.day::text,count(*)::int registered,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM activity a WHERE a.user_id=c.id AND a.day=c.day+1))::int d1,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM activity a WHERE a.user_id=c.id AND a.day=c.day+7))::int d7,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM activity a WHERE a.user_id=c.id AND a.day=c.day+30))::int d30
    FROM cohort c GROUP BY c.day ORDER BY c.day`,[w.start,w.asOf,w.end])).rows;
    res.json({window:w,coverage:c,unit:'registered_user',items:rows.map(row=>({day:row.day,registered:row.registered,periods:[1,7,30].map(days=>{
      const start=new Date(row.day+'T00:00:00+08:00').getTime(),mature=start+(days+1)*dayMs<=new Date(w.asOf).getTime(),complete=start+days*dayMs>=new Date(c.startedAt).getTime();
      return {days,status:!mature?'observing':!complete?'unavailable':'complete',retained:mature&&complete?row['d'+days]:null,rate:mature&&complete?rates(row['d'+days],row.registered):null};
    })}))});
  });
  app.get('/api/admin/analytics/segments',requireManagement,async(req,res)=>{
    const w=window(req);
    const counts=(await query(`WITH ${eligible},${activity},active AS (SELECT DISTINCT a.user_id FROM activity a JOIN eligible u ON u.id=a.user_id)
    SELECT (SELECT count(*)::int FROM eligible) total,
      (SELECT count(*)::int FROM eligible WHERE created_at >= $1 AND created_at < $2) new_users,
      (SELECT count(*)::int FROM active) active,
      (SELECT count(*)::int FROM eligible u WHERE NOT EXISTS(SELECT 1 FROM active a WHERE a.user_id=u.id)) inactive,
      (SELECT count(DISTINCT t.user_id)::int FROM trips t JOIN eligible u ON u.id=t.user_id WHERE t.created_at >= $1 AND t.created_at < $2) planners,
      (SELECT count(DISTINCT t.user_id)::int FROM citywalks t JOIN eligible u ON u.id=t.user_id WHERE t.created_at >= $1 AND t.created_at < $2) walkers,
      (SELECT count(DISTINCT p.user_id)::int FROM product_events p JOIN eligible u ON u.id=p.user_id WHERE p.event_type='agent.action_completed' AND p.created_at >= $1 AND p.created_at < $2) agent_users`,[w.start,w.end])).rows[0];
    res.json({window:w,counts,overlapping:true,personalIdentifiersIncluded:false,coverage:await coverage(w)});
  });
  app.patch('/api/admin/users/:id/analytics',requireManagement,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),b=z.object({excluded:z.boolean(),confirmation:z.literal('change-analytics-scope')}).strict().parse(req.body);
    const result=await transaction(async c=>{
      const u=(await c.query('SELECT id,analytics_excluded FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!u)throw fail('用户不存在',404);
      if(u.analytics_excluded!==b.excluded){
        await c.query('UPDATE users SET analytics_excluded=$2 WHERE id=$1',[id,b.excluded]);
        await events.append({userId:req.user.id,kind:'admin',action:'user.analytics_scope',resourceId:id,requestId:req.operationRequestId,metadata:{excluded:b.excluded}},c);
      }
      return {id,excluded:b.excluded};
    });res.json(result);
  });
  app.get('/api/admin/analytics/scope',requireManagement,async(req,res)=>{
    const q=z.string().trim().max(80).default('').parse(req.query.q).replace(/[\\%_]/g,'\\$&');
    const rows=(await query(`SELECT u.id,u.username,u.nickname,u.analytics_excluded,
      (u.role='admin' OR EXISTS(SELECT 1 FROM admin_memberships m WHERE m.user_id=u.id AND m.enabled)) staff
      FROM users u WHERE ($1='' AND u.analytics_excluded) OR ($1<>'' AND (u.username ILIKE '%'||$1||'%' OR u.nickname ILIKE '%'||$1||'%')) ORDER BY u.username LIMIT 31`,[q])).rows;
    res.json({items:rows.slice(0,30),hasMore:rows.length>30});
  });
}
