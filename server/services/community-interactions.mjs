import {z} from 'zod';
import {randomUUID} from 'node:crypto';
export const visiblePost=(alias='p')=>`${alias}.hidden_at IS NULL AND NOT ${alias}.auto_shared`;
export async function requireVisiblePost(c,id,lock=false){
  const p=(await c.query(`SELECT p.id FROM posts p WHERE p.id=$1 AND ${visiblePost()}${lock?' FOR SHARE':''}`,[id])).rows[0];
  if(!p)throw Object.assign(Error('内容不存在或已隐藏'),{status:404});return p;
}
export function installCommunityInteractions(app,{query,transaction,auth,onReaction=async()=>{},onComment=async()=>{}}){
  app.get('/api/posts/:id/comments',auth,async(req,res)=>{
    const id=z.uuid().parse(req.params.id);await requireVisiblePost({query},id);
    res.json((await query(`SELECT c.id,c.body,c.created_at,u.nickname,u.avatar FROM comments c JOIN users u ON c.user_id=u.id
      JOIN posts p ON p.id=c.post_id WHERE c.post_id=$1 AND c.hidden_at IS NULL AND ${visiblePost()} ORDER BY c.created_at DESC,c.id LIMIT 100`,[id])).rows);
  });
  app.post('/api/posts/:id/comments',auth,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),b=z.object({body:z.string().trim().min(1).max(500)}).parse(req.body);
    await transaction(async c=>{await requireVisiblePost(c,id,true);const commentId=randomUUID();await c.query('INSERT INTO comments(id,user_id,post_id,body) VALUES($1,$2,$3,$4)',[commentId,req.user.id,id,b.body]);await onComment(c,{id,userId:req.user.id,commentId});});res.json({ok:true});
  });
  app.post('/api/posts/:id/reactions',auth,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),b=z.object({kind:z.enum(['like','save','recommend']),active:z.boolean()}).parse(req.body);
    await transaction(async c=>{if(b.active){await requireVisiblePost(c,id,true);await c.query('INSERT INTO reactions(user_id,post_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[req.user.id,id,b.kind]);}
      else await c.query('DELETE FROM reactions WHERE user_id=$1 AND post_id=$2 AND kind=$3',[req.user.id,id,b.kind]);await onReaction(c,{id,userId:req.user.id,...b});});res.json({ok:true});
  });
  app.post('/api/posts/:id/view',auth,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),b=z.object({seconds:z.number().int().min(0).max(120)}).parse(req.body);
    await transaction(async c=>{await requireVisiblePost(c,id,true);await c.query('INSERT INTO browse_events(user_id,post_id,dwell_seconds) VALUES($1,$2,$3) ON CONFLICT(user_id,post_id,day) DO UPDATE SET dwell_seconds=LEAST(120,browse_events.dwell_seconds+excluded.dwell_seconds),created_at=now()',[req.user.id,id,b.seconds]);});res.json({recorded:true});
  });
}
