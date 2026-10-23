/* 定义后台操作的参数和接口映射。 */

import {z} from 'zod';
const slug=z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/);
const source=z.object({title:z.string().trim().min(1).max(120),url:z.url().max(2000).refine(v=>{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password;},'来源必须为不含登录凭据的 HTTPS 链接'),checkedAt:z.iso.date()}).strict();
const classicInput=z.object({id:slug,title:z.string().trim().min(1).max(80),cityId:z.string().min(1).max(80),stopIds:z.array(z.string().min(1).max(200)).min(2).max(20),sources:z.array(source).min(1).max(5),theme:z.enum(['mint','peach','yellow']).default('mint'),motif:z.enum(['bridge','gate','lake']).default('bridge'),enabled:z.boolean(),version:z.number().int().positive().optional()}).strict();
export const adminActions=Object.freeze({
 'user.status':{method:'PATCH',path:'/users/:id/status',permission:'users.manage',id: z.uuid(),
   input:z.object({disabled:z.boolean(),reason:z.enum(['support','security','requested'])}).strict(),
   audit:b=>b.disabled?'user.disable':'user.enable',confirmation:'existing confirmation dialog',replay:'same target state is a no-op',scope:'ordinary account; never self or administrator'},
 'message.send':{method:'POST',path:'/messages/:id/send',permission:'messages.manage',id:z.uuid(),
   input:z.object({version:z.number().int().positive(),recipientCount:z.number().int().positive(),confirmation:z.literal('send')}).strict(),
   audit:()=> 'message.send',confirmation:'send + preview version + recipient count',replay:'sent campaign returns its existing result',scope:'own draft and locked recipient snapshot'},
 'classic.create':{method:'POST',path:'/citywalks',permission:'classics.manage',id:slug,input:classicInput,
   audit:()=> 'classic.create',confirmation:'existing verify and save form',replay:'duplicate ID is rejected',scope:'existing places; verified walking route required when published'},
 'classic.update':{method:'PUT',path:'/citywalks/:id',permission:'classics.manage',id:slug,input:classicInput,
   audit:()=> 'classic.edit',confirmation:'existing verify and save form',replay:'optimistic version conflict',scope:'existing route; verified walking route required when published'},
 'classic.unpublish':{method:'PATCH',path:'/citywalks/:id/visibility',permission:'classics.manage',id:slug,
   input:z.object({version:z.number().int().positive(),enabled:z.literal(false)}).strict(),
   audit:()=> 'classic.unpublish',confirmation:'existing unpublish confirmation',replay:'optimistic version conflict',scope:'unpublish only; preserve route'},
});
export const adminActionRoutes=Object.values(adminActions).map(d=>[d.method,new RegExp('^'+d.path.replace(/:id/g,'[^/]+')+'$'),d.permission]);
