/* 管理分享草稿、来源路线和草稿版本。 */

import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {publicRoute} from '../services/discovery.mjs';
export const failure=(message,status=400)=>Object.assign(Error(message),{status});
export const paging=z.object({limit:z.coerce.number().int().min(1).max(30).default(12),offset:z.coerce.number().int().min(0).max(10000).default(0)});
const source=z.object({kind:z.enum(['journey','citywalk']),id:z.uuid()}).strict();
const create=z.object({id:z.uuid(),source:source.optional(),postId:z.uuid().optional()}).strict().refine(b=>!(b.source&&b.postId));
const patch=z.object({version:z.number().int().min(1),title:z.string().trim().max(100),body:z.string().trim().max(4000),
 tags:z.array(z.string().trim().min(1).max(20)).max(8),mediaIds:z.array(z.uuid()).max(9)}).strict()
 .refine(b=>new Set(b.mediaIds).size===b.mediaIds.length&&new Set(b.tags).size===b.tags.length);
export async function ownedDraft(c,id,userId,lock=false){
 const d=(await c.query(`SELECT * FROM post_drafts WHERE id=$1 AND user_id=$2${lock?' FOR UPDATE':''}`,[z.uuid().parse(id),userId])).rows[0];
 if(!d)throw failure('草稿不存在',404);return d;
}
export function assertDraftVersion(d,version){if(d.published_post_id)throw failure('这份草稿已经发布',409);if(d.version!==version)throw failure('草稿已在其他页面修改，请重新加载',409);}
async function ownedSource(c,ref,userId){
 const row=(await c.query(`SELECT * FROM ${ref.kind==='journey'?'trips':'citywalks'} WHERE id=$1 AND user_id=$2`,[ref.id,userId])).rows[0];
 if(!row)throw failure('路线不存在',404);
 const snapshot=publicRoute(ref.kind,row);
 if(Buffer.byteLength(JSON.stringify(snapshot))>180000)throw failure('路线较大，请选择较短的行程分享');
 return {snapshot,version:row.version||1,title:row.title};
}
export function installDraftRoutes(app,{auth,query,transaction,onPublish=async()=>{}}){
 app.post('/api/social/drafts',auth,async(req,res)=>{
  const b=create.parse(req.body);
  const d=await transaction(async c=>{
   await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
   const existing=(await c.query('SELECT * FROM post_drafts WHERE id=$1',[b.id])).rows[0];
   if(existing){if(existing.user_id!==req.user.id)throw failure('草稿不存在',404);return existing;}
   if(Number((await c.query('SELECT count(*) n FROM post_drafts WHERE user_id=$1 AND published_post_id IS NULL',[req.user.id])).rows[0].n)>=100)throw failure('草稿已达 100 份，请先整理',409);
   let snapshot={},title='',body='',tags=[],ref=b.source,sourceVersion=null,editVersion=null,media=[];
   if(b.postId){
    const p=(await c.query('SELECT * FROM posts WHERE id=$1 AND user_id=$2 AND NOT auto_shared',[b.postId,req.user.id])).rows[0];
    if(!p)throw failure('帖子不存在',404);
    if(p.hidden_at)throw failure('内容已隐藏，暂不能编辑',409);
    snapshot=p.snapshot;title=p.title;body=p.body;tags=p.tags;editVersion=p.revision;
    const s=(await c.query('SELECT * FROM post_sources WHERE post_id=$1',[p.id])).rows[0];
    if(s){ref={kind:s.kind,id:s.source_id};sourceVersion=s.source_version;}
    media=(await c.query('SELECT media_id FROM post_media WHERE post_id=$1 ORDER BY position',[p.id])).rows.map(r=>r.media_id);
   }else if(ref){const s=await ownedSource(c,ref,req.user.id);snapshot=s.snapshot;sourceVersion=s.version;title=s.title.slice(0,100);}
   return (await c.query(`INSERT INTO post_drafts(id,user_id,title,body,tags,source_kind,source_id,source_version,snapshot,edit_post_id,edit_post_version,media_ids)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[b.id,req.user.id,title,body,tags,ref?.kind||null,ref?.id||null,sourceVersion,JSON.stringify(snapshot),b.postId||null,editVersion,media])).rows[0];
  });res.json(d);
 });
 app.get('/api/social/drafts',auth,async(req,res)=>{
  const {limit,offset}=paging.parse(req.query);const rows=(await query(`SELECT id,title,version,source_kind,updated_at FROM post_drafts WHERE user_id=$1 AND published_post_id IS NULL ORDER BY updated_at DESC,id LIMIT $2 OFFSET $3`,[req.user.id,limit+1,offset])).rows;
  res.json({items:rows.slice(0,limit),hasMore:rows.length>limit});
 });
 app.get('/api/social/drafts/:id',auth,async(req,res)=>res.json(await ownedDraft({query},req.params.id,req.user.id)));
 app.put('/api/social/drafts/:id',auth,async(req,res)=>{
  const b=patch.parse(req.body);const d=await transaction(async c=>{
   const d=await ownedDraft(c,req.params.id,req.user.id,true);assertDraftVersion(d,b.version);
   const media=(await c.query('SELECT id FROM social_media WHERE user_id=$1 AND id=ANY($2::uuid[])',[req.user.id,b.mediaIds])).rows;
   if(media.length!==b.mediaIds.length)throw failure('图片不可用',400);
   return (await c.query(`UPDATE post_drafts SET title=$3,body=$4,tags=$5,media_ids=$6,version=version+1,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,[d.id,req.user.id,b.title,b.body,b.tags,b.mediaIds])).rows[0];
  });res.json(d);
 });
 app.delete('/api/social/drafts/:id',auth,async(req,res)=>{
  const b=z.object({version:z.number().int().min(1)}).strict().parse(req.body);
  await transaction(async c=>{const d=await ownedDraft(c,req.params.id,req.user.id,true);assertDraftVersion(d,b.version);await c.query('DELETE FROM post_drafts WHERE id=$1',[d.id]);});res.json({ok:true});
 });
 app.post('/api/social/drafts/:id/publish',auth,async(req,res)=>{
  const {version}=z.object({version:z.number().int().min(1)}).strict().parse(req.body);
  const result=await transaction(async c=>{
   const d=await ownedDraft(c,req.params.id,req.user.id,true);
   if(d.published_post_id)return {id:d.published_post_id,replayed:true};
   assertDraftVersion(d,version);if(!d.title.trim()||!d.body.trim())throw failure('请填写标题和正文');
   const id=d.edit_post_id||randomUUID();
   if(d.edit_post_id){
    const r=await c.query(`UPDATE posts SET title=$3,body=$4,tags=$5,snapshot=$6,revision=revision+1,updated_at=now()
     WHERE id=$1 AND user_id=$2 AND revision=$7 AND hidden_at IS NULL RETURNING id`,[id,req.user.id,d.title,d.body,d.tags,JSON.stringify(d.snapshot),d.edit_post_version]);
    if(!r.rowCount)throw failure('帖子已变化或已隐藏，请重新打开编辑',409);
   }else await c.query(`INSERT INTO posts(id,user_id,title,body,tags,snapshot) VALUES($1,$2,$3,$4,$5,$6)`,[id,req.user.id,d.title,d.body,d.tags,JSON.stringify(d.snapshot)]);
   if(d.source_id)await c.query(`INSERT INTO post_sources(post_id,kind,source_id,source_version) VALUES($1,$2,$3,$4) ON CONFLICT(post_id) DO NOTHING`,[id,d.source_kind,d.source_id,d.source_version]);
   await c.query('DELETE FROM post_media WHERE post_id=$1',[id]);
   for(const [position,mediaId] of d.media_ids.entries()){
    const media=await c.query('SELECT id FROM social_media WHERE id=$1 AND user_id=$2',[mediaId,req.user.id]);
    if(!media.rowCount)throw failure('图片不可用');
    await c.query('INSERT INTO post_media(post_id,media_id,position) VALUES($1,$2,$3)',[id,mediaId,position]);
   }
   await onPublish(c,id);
   await c.query('UPDATE post_drafts SET published_post_id=$2,updated_at=now() WHERE id=$1',[d.id,id]);return {id,replayed:false};
  });res.json(result);
 });
}
