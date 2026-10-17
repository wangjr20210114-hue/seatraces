import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,unlink,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import {z} from 'zod';
import {failure,ownedDraft} from './drafts.mjs';
export function installSocialMedia(app,{auth,query,transaction,mediaDir=fileURLToPath(new URL('../../.runtime/social-media/',import.meta.url))}){
 let processing=0;
 const filename=id=>path.join(mediaDir,z.uuid().parse(id)+'.webp');
 app.post('/api/social/drafts/:id/media',auth,async(req,res)=>{
  const b=z.object({image:z.string().max(1800000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/)}).strict().parse(req.body);
  await ownedDraft({query},req.params.id,req.user.id);
  if(processing>=2)throw failure('图片正在处理，请稍后重试',429);processing++;
  const id=randomUUID();let written=false;
  try{
   let image,info;
   try{const s=sharp(Buffer.from(b.image.split(',')[1],'base64'),{limitInputPixels:16000000,animated:false});info=await s.metadata();
    if(!['jpeg','png','webp'].includes(info.format)||(info.pages||1)>1)throw Error('format');
    ({data:image,info}=await s.rotate().resize(1440,1440,{fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer({resolveWithObject:true}));
    if(image.length>1500000)throw Error('size');
   }catch{throw failure('请选择不超过 1600 万像素的静态 JPG、PNG 或 WebP 图片');}
   await transaction(async c=>{
    await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
    const d=await ownedDraft(c,req.params.id,req.user.id,true);if(d.published_post_id)throw failure('草稿已经发布',409);
    if(Number((await c.query('SELECT count(*) n FROM social_media WHERE draft_id=$1',[d.id])).rows[0].n)>=30)throw failure('本草稿上传次数已达上限，请整理后新建草稿',409);
    if(Number((await c.query('SELECT coalesce(sum(bytes),0) n FROM social_media WHERE user_id=$1',[req.user.id])).rows[0].n)+image.length>100*1024*1024)throw failure('图片空间已满',409);
    await mkdir(mediaDir,{recursive:true,mode:0o700});await writeFile(filename(id),image,{flag:'wx',mode:0o600});written=true;
    await c.query('INSERT INTO social_media(id,user_id,draft_id,width,height,bytes) VALUES($1,$2,$3,$4,$5,$6)',[id,req.user.id,d.id,info.width,info.height,image.length]);
   });res.json({id,url:'/api/social/media/'+id,width:info.width,height:info.height,bytes:image.length});
  }catch(e){if(written)await unlink(filename(id)).catch(()=>{});throw e;}finally{processing--;}
 });
 app.get('/api/social/media/:id',auth,async(req,res)=>{
  const id=z.uuid().parse(req.params.id);
  const r=await query(`SELECT m.id FROM social_media m WHERE m.id=$1 AND (m.user_id=$2 OR EXISTS(
    SELECT 1 FROM post_media pm JOIN posts p ON p.id=pm.post_id JOIN users u ON u.id=p.user_id WHERE pm.media_id=m.id AND NOT p.auto_shared AND p.hidden_at IS NULL AND u.disabled_at IS NULL))`,[id,req.user.id]);
  if(!r.rowCount)throw failure('图片不存在',404);
  const s=await stat(filename(id)).catch(()=>null);if(!s?.isFile())throw failure('图片暂不可用',404);
  res.set({'Content-Type':'image/webp','Content-Length':s.size,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
  createReadStream(filename(id)).on('error',()=>res.destroy()).pipe(res);
 });
}
