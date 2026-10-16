import {AsyncLocalStorage} from 'node:async_hooks';
const storage=new AsyncLocalStorage();
const uuid=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export const requestContext=()=>storage.getStore();
export function withRequestContext(req,res,next) {
  if(!req.user||!uuid.test(req.operationRequestId||''))return next();
  // These are correlation hints, not authorization; handlers still validate
  // resource ownership before any write. Never store cookies, bodies or URLs.
  const path=req.originalUrl.split('?')[0];
  const session=path.match(/^\/api\/journey\/sessions\/([\da-f-]{36})(?:\/|$)/)?.[1];
  const draft=/^\/api\/citywalks(?:\/|$)/.test(path)?req.body?.draftId:null;
  const flowId=uuid.test(session||'')?session:uuid.test(draft||'')?draft:null;
  storage.run({requestId:req.operationRequestId,flowId,userId:req.user.id},next);
}
export async function applyRequestContext(client) {
  const context=requestContext();if(!context)return;
  await client.query("SELECT set_config('seatraces.request_id',$1,true),set_config('seatraces.flow_id',$2,true)",[context.requestId,context.flowId||'']);
}
export const trackedMutation=sql=>typeof sql==='string'&&/^\s*(?:INSERT\s+INTO|UPDATE)\s+(?:public\.)?(journey_sessions|trips|citywalks|citywalk_drafts|user_travel_memory|agent_actions)\b/i.test(sql);
