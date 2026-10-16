import {adminActions} from './action-definitions.mjs';
import {can,managementAccess} from './permissions.mjs';
const forbidden=()=>Object.assign(Error('没有此后台操作权限'),{status:403});
export function prepareAdminAction(req,key){
 const d=Object.hasOwn(adminActions,key)?adminActions[key]:null;
 if(!d||!req.user?.id||!can(req.adminAccess,d.permission)||req.method!==d.method)throw forbidden();
 const b=d.input.parse(req.body),id=d.id.parse(req.params?.id??b.id);
 if(b.id&&b.id!==id)throw Object.assign(Error('对象编号不一致'),{status:400});
 return {d,b,id};
}
export function createAdminActionRunner({transaction,events}){
 return async(req,key,handler)=>{
  const {d,b,id}=prepareAdminAction(req,key);
  return transaction(async c=>{
   // Recheck authorization at the write boundary, including changes while a map
   // verification was in flight. Locking prevents permission changes mid-write.
   const user=(await c.query('SELECT * FROM users WHERE id=$1 FOR SHARE',[req.user.id])).rows[0];
   const member=(await c.query('SELECT role management_role,enabled management_enabled,version management_version FROM admin_memberships WHERE user_id=$1 FOR SHARE',[req.user.id])).rows[0];
   const access=managementAccess(user?{...user,...member}:null);
   if(!can(access,d.permission)||access.version!==req.adminAccess.version)throw forbidden();
   const outcome=await handler({c,b,id});
   if(!outcome||!Object.hasOwn(outcome,'value'))throw Error('Invalid action outcome');
   if(outcome.changed!==false)await events.append({userId:req.user.id,kind:'admin',action:d.audit(b),resourceId:id,requestId:req.operationRequestId,metadata:{...outcome.metadata,operation:key}},c);
   return outcome.value;
  });
 };
}
