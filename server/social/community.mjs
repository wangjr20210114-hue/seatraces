import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {failure,paging} from './drafts.mjs';
import {requireVisiblePost,visiblePost} from '../services/community-interactions.mjs';
export async function socialNotify(c,{owner,actor,post=null,kind,key}){
 if(owner===actor)return;
 await c.query(`INSERT INTO social_notifications(user_id,actor_id,post_id,kind,resource_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[owner,actor,post,kind,key]);
}
export const cardSelect=`p.id,p.user_id,p.title,left(p.body,100) excerpt,p.created_at,p.revision,p.is_synthetic,u.nickname,u.avatar,
 p.user_id=$1 AS "isOwn",p.snapshot->'cities' cities,p.snapshot->>'kind' kind,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('lat',v->'lat','lng',v->'lng')),'[]') FROM (SELECT v FROM jsonb_path_query(p.snapshot,'$.days[*].stops[*]') v LIMIT 16) points) preview,
 jsonb_array_length(coalesce(p.snapshot->'days','[]'::jsonb)) day_count,
 (SELECT media_id FROM post_media WHERE post_id=p.id ORDER BY position LIMIT 1) cover_id,
 (SELECT count(*)::int FROM reactions WHERE post_id=p.id AND kind='like') likes,
 EXISTS(SELECT 1 FROM reactions WHERE post_id=p.id AND user_id=$1 AND kind='like') liked`;
export function installSocialCommunity(app,{auth,query,transaction,rank=async rows=>({rows,version:'chronological/1'}),recommend,onImpression=async()=>{},onVisible=async()=>{}}){
 const feed=async(req,res)=>{
  const b=z.object({scope:z.enum(['recommended','following','mine']).default('recommended'),q:z.string().trim().max(60).refine(s=>!s.includes('\0'),'搜索词包含无效字符').default(''),city:z.string().trim().max(100).refine(s=>!s.includes('\0'),'城市包含无效字符').default(''),limit:z.coerce.number().int().min(1).max(30).default(12),cursor:z.string().max(80).optional(),...(req.method==='POST'?{exclude:z.array(z.uuid()).max(600).default([])}:{})}).strict().parse(req.method==='POST'?req.body:req.query);
  if(req.method==='POST'&&(b.scope!=='recommended'||b.cursor))throw failure('新一批推荐不能携带旧分页或其他范围');
  let session,start=0;
  if(b.cursor){
   const [id,index,...extra]=b.cursor.split(':');z.uuid().parse(id);if(extra.length||!/^\d{1,3}$/.test(index))throw failure('分页参数不正确');start=Number(index);
   session=(await query('SELECT * FROM social_feed_sessions WHERE id=$1 AND user_id=$2 AND expires_at>now()',[id,req.user.id])).rows[0];
   if(!session)throw failure('这一页已过期，请刷新',410);if(session.scope!==b.scope)throw failure('分页范围不一致');
  }else{
   // A bounded, frozen list of IDs prevents duplicate or skipped cards when a
   // new post or a preference change arrives between page requests.
   const recommendation=b.scope==='recommended'&&recommend?await recommend(req.user,{q:b.q,city:b.city,exclude:b.exclude||[],explore:req.method==='POST'}):null;
   let rows=recommendation?.rows||(await query(`SELECT p.id,p.user_id,p.tags,p.created_at,ps.kind source_kind FROM posts p JOIN users u ON u.id=p.user_id LEFT JOIN post_sources ps ON ps.post_id=p.id
     WHERE ${visiblePost()} AND u.disabled_at IS NULL
     AND ($2<>'mine' OR p.user_id=$1)
     AND ($2<>'following' OR EXISTS(SELECT 1 FROM user_follows f WHERE f.user_id=$1 AND f.author_id=p.user_id))
     AND NOT EXISTS(SELECT 1 FROM social_feedback f WHERE f.user_id=$1 AND f.post_id=p.id)
     AND NOT(p.id=ANY($5::uuid[]))
     AND ($3='' OR p.title ILIKE $3 ESCAPE '\\' OR $4=ANY(p.tags)) ORDER BY p.created_at DESC,p.id DESC LIMIT 120`,[req.user.id,b.scope,b.q?'%'+b.q.replace(/[\\%_]/g,'\\$&')+'%':'',b.q,b.exclude||[]])).rows;
   let version=recommendation?.version||'chronological/1';if(b.scope==='recommended'&&!recommendation){const r=await rank(rows,req.user);rows=r.rows;version=r.version;}
   session={id:randomUUID(),post_ids:rows.map(p=>p.id),scope:b.scope,recommendation_id:recommendation?.requestId||null};
   await transaction(async c=>{await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
    await c.query(`DELETE FROM social_feed_sessions WHERE user_id=$1 AND (expires_at<=now() OR id IN(SELECT id FROM social_feed_sessions WHERE user_id=$1 ORDER BY expires_at DESC OFFSET 5))`,[req.user.id]);
    await c.query('INSERT INTO social_feed_sessions(id,user_id,post_ids,scope,profile_version,recommendation_id) VALUES($1,$2,$3,$4,$5,$6)',[session.id,req.user.id,session.post_ids,b.scope,version,session.recommendation_id]);});
  }
  const ids=session.post_ids.slice(start,start+b.limit);
  const items=ids.length?(await query(`SELECT ${cardSelect} FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=ANY($2::uuid[]) AND ${visiblePost()} AND u.disabled_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM social_feedback f WHERE f.user_id=$1 AND f.post_id=p.id)
   AND ($3<>'following' OR EXISTS(SELECT 1 FROM user_follows f WHERE f.user_id=$1 AND f.author_id=p.user_id)) ORDER BY array_position($2::uuid[],p.id)`,[req.user.id,ids,b.scope])).rows:[];
  const next=start+b.limit;res.json({items,nextCursor:next<session.post_ids.length?session.id+':'+next:null,requestId:session.recommendation_id||null});
 };
 app.get('/api/social/feed',auth,feed);
 app.post('/api/social/feed',auth,feed);
 app.get('/api/social/posts/:id',auth,async(req,res)=>{
  const id=z.uuid().parse(req.params.id);
  const p=(await query(`SELECT ${cardSelect},p.body,p.tags,p.snapshot,
   EXISTS(SELECT 1 FROM user_follows WHERE user_id=$1 AND author_id=p.user_id) following,
   ARRAY(SELECT kind FROM reactions WHERE post_id=p.id AND user_id=$1) reactions,
   EXISTS(SELECT 1 FROM social_feedback WHERE user_id=$1 AND post_id=p.id) not_interested
   FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$2 AND ${visiblePost()} AND u.disabled_at IS NULL`,[req.user.id,id])).rows[0];
  if(!p)throw failure('帖子不存在或已隐藏',404);
  p.media=(await query('SELECT m.id,m.width,m.height FROM post_media pm JOIN social_media m ON m.id=pm.media_id WHERE pm.post_id=$1 ORDER BY pm.position',[id])).rows;
  res.json(p);
 });
 app.put('/api/social/authors/:id/follow',auth,async(req,res)=>{
  const id=z.uuid().parse(req.params.id),b=z.object({active:z.boolean()}).strict().parse(req.body);
  if(id===req.user.id)throw failure('不能关注自己');
  await transaction(async c=>{
   if(!(await c.query('SELECT id FROM users WHERE id=$1 AND disabled_at IS NULL',[id])).rowCount)throw failure('作者不存在',404);
   if(b.active){await c.query('INSERT INTO user_follows(user_id,author_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.user.id,id]);await socialNotify(c,{owner:id,actor:req.user.id,kind:'follow',key:req.user.id});}
   else await c.query('DELETE FROM user_follows WHERE user_id=$1 AND author_id=$2',[req.user.id,id]);
  });res.json({following:b.active});
 });
 app.put('/api/social/posts/:id/feedback',auth,async(req,res)=>{
  const id=z.uuid().parse(req.params.id),b=z.object({notInterested:z.boolean()}).strict().parse(req.body);
  await transaction(async c=>{await requireVisiblePost(c,id,true);if(b.notInterested)await c.query("INSERT INTO social_feedback(user_id,post_id,kind) VALUES($1,$2,'not_interested') ON CONFLICT DO NOTHING",[req.user.id,id]);else await c.query('DELETE FROM social_feedback WHERE user_id=$1 AND post_id=$2',[req.user.id,id]);});res.json({ok:true});
 });
 app.post('/api/social/posts/:id/adopt',auth,async(req,res)=>{
  const id=z.uuid().parse(req.params.id);z.object({}).strict().parse(req.body);
  await transaction(async c=>{await requireVisiblePost(c,id,true);
   const p=(await c.query('SELECT snapshot FROM posts WHERE id=$1',[id])).rows[0];
   if(!p?.snapshot?.days?.some(d=>d.stops?.length))throw failure('这篇帖子没有可用路线');
   await c.query('INSERT INTO social_adoptions(user_id,post_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.user.id,id]);
  });res.json({ok:true,requiresNewDates:true});
 });
 app.post('/api/social/posts/:id/impressions',auth,async(req,res)=>{
  const id=z.uuid().parse(req.params.id),b=z.object({id:z.uuid(),context:z.enum(['feed','detail']),requestId:z.uuid().optional()}).strict().parse(req.body);
  const r=await transaction(async c=>{await requireVisiblePost(c,id,true);
   await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
   const existing=(await c.query('SELECT id,user_id,post_id FROM social_impressions WHERE id=$1',[b.id])).rows[0];
   if(existing){if(existing.user_id!==req.user.id||existing.post_id!==id)throw failure('浏览记录不存在',404);return {id:b.id};}
   if((await c.query("SELECT id FROM social_impressions WHERE user_id=$1 AND created_at>now()-interval '1 minute' LIMIT 61",[req.user.id])).rowCount>=60)throw failure('浏览记录过于频繁',429);
   await c.query('INSERT INTO social_impressions(id,user_id,post_id,context) VALUES($1,$2,$3,$4)',[b.id,req.user.id,id,b.context]);
   await onImpression(c,{id:b.id,userId:req.user.id,postId:id,requestId:b.requestId});return {id:b.id};
  });res.json(r);
 });
 app.put('/api/social/impressions/:id',auth,async(req,res)=>{
  const id=z.uuid().parse(req.params.id),b=z.object({visibleMs:z.number().int().min(0).max(120000)}).strict().parse(req.body);
  await transaction(async c=>{
   const i=(await c.query(`SELECT * FROM social_impressions WHERE id=$1 AND user_id=$2 AND created_at>now()-interval '1 day' FOR UPDATE`,[id,req.user.id])).rows[0];if(!i)throw failure('浏览记录已过期',404);
   await requireVisiblePost(c,i.post_id,true);
   const n=Math.max(i.visible_ms,Math.min(b.visibleMs,Math.max(0,Date.now()-new Date(i.created_at)))),delta=Math.floor(n/1000)-Math.floor(i.visible_ms/1000);
   await c.query('UPDATE social_impressions SET visible_ms=$2,updated_at=now() WHERE id=$1',[id,n]);
   await onVisible(c,{id,visibleMs:n});
   if(delta>0)await c.query(`INSERT INTO browse_events(user_id,post_id,dwell_seconds) VALUES($1,$2,$3) ON CONFLICT(user_id,post_id,day)
    DO UPDATE SET dwell_seconds=LEAST(120,browse_events.dwell_seconds+excluded.dwell_seconds),created_at=now()`,[req.user.id,i.post_id,Math.min(120,delta)]);
  });res.json({ok:true});
 });
 app.get('/api/social/notifications',auth,async(req,res)=>{
  const {limit,offset}=paging.parse(req.query);const rows=(await query(`SELECT n.id,n.kind,n.read_at,n.created_at,n.post_id,u.nickname,u.avatar,p.title FROM social_notifications n
   JOIN users u ON u.id=n.actor_id LEFT JOIN posts p ON p.id=n.post_id WHERE n.user_id=$1 AND (n.post_id IS NULL OR (${visiblePost()}))
   ORDER BY n.created_at DESC,n.id LIMIT $2 OFFSET $3`,[req.user.id,limit+1,offset])).rows;res.json({items:rows.slice(0,limit),hasMore:rows.length>limit});
 });
 app.put('/api/social/notifications/:id/read',auth,async(req,res)=>{await query('UPDATE social_notifications SET read_at=coalesce(read_at,now()) WHERE id=$1 AND user_id=$2',[z.uuid().parse(req.params.id),req.user.id]);res.json({ok:true});});
}
