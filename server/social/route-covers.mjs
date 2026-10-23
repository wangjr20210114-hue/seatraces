/* 根据路线站点生成并提供地图封面。 */

import {reserveApiCall} from '../repositories/api-usage.mjs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {routeMap,routeViewport} from '../../public/route-map.js';
import {visiblePost} from '../services/community-interactions.mjs';
import {createPacedQueue} from '../integrations/paced-queue.mjs';
import {failure} from './drafts.mjs';

export function staticMapParams(snapshot) {
 const count=(snapshot.days||[]).reduce((n,d)=>n+(d.stops?.length||0),0);
 if(count>200)throw failure('路线过长，暂不能生成封面',422);
 const {stops,connections}=routeMap(snapshot);
 if(!stops.length)throw failure('路线没有可显示的坐标',422);
 const path=connections.flatMap(c=>c.path),positions=[...stops.map(p=>p.position),...path];
 const view=routeViewport(positions),coord=p=>p.map(n=>n.toFixed(6)).join(',');
 const selected=stops.length<=10?stops:Array.from({length:10},(_,i)=>stops[Math.round(i*(stops.length-1)/9)]);
 const params={size:'480*480',zoom:String(view.zoom),location:coord(view.location),scale:'1',
  markers:selected.map((s,i)=>`small,0x158e85,${String.fromCharCode(65+i)}:${coord(s.position)}`).join('|')};
 if(path.length){const sampled=path.length<=240?path:Array.from({length:240},(_,i)=>path[Math.round(i*(path.length-1)/239)]);params.paths='4,0x158e85,1,,:'+sampled.map(coord).join(';');}
 return params;
}

export function createStaticMapRenderer({env=process.env,fetchImage=fetch,schedule=createPacedQueue(),reserve=reserveApiCall,now=Date.now}={}) {
 let pending=0;
 return async params=>{
  if(!env.AMAP_KEY)throw failure('地图暂未配置',503);
  if(pending>=24)throw failure('封面正在生成，请稍后重试',429);
  pending++;const queuedAt=now();
  try{return await schedule(async()=>{
   if(now()-queuedAt>15000)throw failure('封面等待超时，请稍后重试',429);
   await reserve('Amap');
   const u=new URL('https://restapi.amap.com/v3/staticmap');u.search=new URLSearchParams({...params,key:env.AMAP_KEY});
   const r=await fetchImage(u,{signal:AbortSignal.timeout(12000),redirect:'error'});
   if(!r.ok||!r.headers.get('content-type')?.startsWith('image/png')){await r.body?.cancel();throw failure('地图封面暂未加载',502);}
   const reader=r.body.getReader(),parts=[];let bytes=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2*1024*1024)throw failure('地图图片过大',502);parts.push(value);}}finally{await reader.cancel();}
   const image=Buffer.concat(parts);if(!image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw failure('地图图片格式不正确',502);
   return image;
  });}catch(e){if(e.status)throw e;throw failure('地图封面暂未加载',502);}finally{pending--;}
 };
}

export function installRouteCovers(app,{auth,query,render=createStaticMapRenderer()}) {
 app.get('/api/social/route-covers/:kind/:id',auth,async(req,res)=>{
  const kind=z.enum(['post','draft','journey','citywalk']).parse(req.params.kind),id=z.uuid().parse(req.params.id);
  let row;
  if(kind==='post')row=(await query(`SELECT p.snapshot FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$1 AND ${visiblePost()} AND u.disabled_at IS NULL`,[id])).rows[0];
  else if(kind==='draft')row=(await query('SELECT snapshot FROM post_drafts WHERE id=$1 AND user_id=$2',[id,req.user.id])).rows[0];
  else if(kind==='journey')row=(await query("SELECT jsonb_build_object('days',plan->'days') AS snapshot FROM trips WHERE id=$1 AND user_id=$2",[id,req.user.id])).rows[0];
  else row=(await query("SELECT jsonb_build_object('days',jsonb_build_array(jsonb_build_object('stops',stops))) AS snapshot FROM citywalks WHERE id=$1 AND user_id=$2",[id,req.user.id])).rows[0];
  if(!row)throw failure('路线不存在或不可访问',404);
  const params=staticMapParams(row.snapshot),etag='"'+createHash('sha256').update(JSON.stringify(params)).digest('hex')+'"';
  res.set({'Cache-Control':'private, no-cache','ETag':etag,'X-Content-Type-Options':'nosniff','Vary':'Cookie'});
  if(req.get('If-None-Match')===etag)return res.status(304).end();
  const image=await render(params);res.type('png').send(image);
 });
}
