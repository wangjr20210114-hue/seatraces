import {z} from 'zod';
import {eventFilters} from './routes.mjs';
import {requireManagement} from './permissions.mjs';
const paging=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),offset:z.coerce.number().int().min(0).max(10000).default(0)});
const text=(v,max=100)=>typeof v==='string'?v.slice(0,max):null;
const oneOf=(v,allowed)=>allowed.includes(v)?v:null;
export function turnSummary(r){
  const v=r.response||{},c=v.classification||{};
  return {id:r.id,requestId:r.request_id,serverRequestId:r.server_request_id,status:r.status,createdAt:r.created_at,finishedAt:r.finished_at,durationMs:r.duration_ms,
    intent:oneOf(v.intent,['operate','software_question','other','clarify']),
    classification:{source:oneOf(c.source,['rule','policy','model','model_abstain','rule_abstain','fallback']),
      confidence:typeof c.confidence==='number'&&c.confidence>=0&&c.confidence<=1?c.confidence:null,capability:text(c.capability,80)},
    clarification:!!v.question,optionCount:Array.isArray(v.question?.options)?v.question.options.length:0,
    steps:(Array.isArray(v.steps)?v.steps:[]).slice(0,12).map(x=>text(x,80)).filter(Boolean),
    retrieval:oneOf(v.retrieval,['hybrid_bge','lexical']),knowledgeVersion:text(v.knowledgeVersion,80),
    sources:(Array.isArray(v.sources)?v.sources:[]).filter(s=>s&&typeof s==='object').slice(0,6).map(s=>({id:text(s.id),title:text(s.title,160),version:text(s.version,80)})),
    actionId:/^[a-f\d-]{36}$/.test(v.actionResult?.id||'')?v.actionResult.id:null,
    error:!!v.error,rawDialogueIncluded:false};
}
export function installAgentInsights(app,{query,events}){
  const audit=(req,action,id)=>events.append({userId:req.user.id,kind:'admin',action,resourceId:id,requestId:req.operationRequestId,metadata:{role:req.adminAccess.role}});
  app.get('/api/admin/agent/conversations',requireManagement,async(req,res)=>{
    const {limit,offset}=paging.parse(req.query),[from,to,userId]=eventFilters(req.query);
    const state=z.enum(['all','issues','pending']).default('all').parse(req.query.state);
    const rows=(await query(`SELECT c.id,c.user_id,u.username,c.revision,c.created_at,c.updated_at,c.busy_until>now() busy,
      (SELECT count(*)::int FROM agent_turns t WHERE t.conversation_id=c.id) turns,
      (SELECT count(*)::int FROM agent_turns t WHERE t.conversation_id=c.id AND t.status='failed') failed_turns,
      (SELECT count(*)::int FROM agent_actions a WHERE a.conversation_id=c.id AND a.status IN ('failed','unknown')) unresolved_actions,
      (SELECT count(*)::int FROM agent_actions a WHERE a.conversation_id=c.id AND a.status='pending' AND a.expires_at>now()) pending_actions,
      (SELECT t.response->>'intent' FROM agent_turns t WHERE t.conversation_id=c.id ORDER BY t.created_at DESC,t.id DESC LIMIT 1) latest_intent
      FROM agent_conversations c JOIN users u ON u.id=c.user_id
      WHERE c.updated_at >= $1 AND c.updated_at < $2 AND ($3::uuid IS NULL OR c.user_id=$3)
      AND ($4='all' OR ($4='issues' AND (EXISTS(SELECT 1 FROM agent_turns t WHERE t.conversation_id=c.id AND t.status='failed') OR EXISTS(SELECT 1 FROM agent_actions a WHERE a.conversation_id=c.id AND a.status IN ('failed','unknown'))))
      OR ($4='pending' AND EXISTS(SELECT 1 FROM agent_actions a WHERE a.conversation_id=c.id AND a.status='pending' AND a.expires_at>now())))
      ORDER BY c.updated_at DESC,c.id DESC LIMIT $5 OFFSET $6`,[from,to,userId,state,limit+1,offset])).rows;
    await audit(req,'agent.list_read',userId);res.json({items:rows.slice(0,limit),hasMore:rows.length>limit,from,to});
  });
  app.get('/api/admin/agent/conversations/:id',requireManagement,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),{limit,offset}=paging.parse(req.query);
    const c=(await query('SELECT c.id,c.user_id,u.username,c.revision,c.created_at,c.updated_at FROM agent_conversations c JOIN users u ON u.id=c.user_id WHERE c.id=$1',[id])).rows[0];
    if(!c)throw Object.assign(Error('会话不存在'),{status:404});
    // Never SELECT input, state, action payload/preview or tool request bodies.
    // Response JSON is reduced to routing/knowledge metadata before returning.
    const rows=(await query(`SELECT id,request_id,server_request_id,response,status,created_at,finished_at,duration_ms FROM agent_turns
      WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,[id,c.user_id,limit+1,offset])).rows;
    const turns=rows.slice(0,limit).map(turnSummary),ids=turns.map(t=>t.id);
    const calls=(await query(`SELECT id,turn_id,action_id,method,split_part(path,'?',1) path,status,outcome,duration_ms,request_id,parent_request_id,created_at,finished_at
      FROM agent_tool_calls WHERE conversation_id=$1 AND user_id=$2 AND (turn_id=ANY($3::uuid[]) OR ($4=0 AND turn_id IS NULL)) ORDER BY created_at,id LIMIT 501`,[id,c.user_id,ids,offset])).rows;
    const actions=(await query(`SELECT id,capability,status,created_at,expires_at,finished_at FROM agent_actions
      WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 101`,[id,c.user_id])).rows;
    const requestIds=[...turns.map(t=>t.serverRequestId),...calls.slice(0,500).flatMap(t=>[t.request_id,t.parent_request_id])].filter(Boolean);
    const effects=(await query(`SELECT id,event_type,resource_type,resource_id,entity_version,request_id,created_at FROM product_events
      WHERE user_id=$1 AND request_id=ANY($2::uuid[]) ORDER BY created_at,id LIMIT 501`,[c.user_id,requestIds])).rows;
    await audit(req,'agent.trace_read',id);
    res.json({conversation:c,turns,hasMore:rows.length>limit,tools:calls.slice(0,500),toolsTruncated:calls.length>500,
      actions:actions.slice(0,100),actionsTruncated:actions.length>100,effects:effects.slice(0,500),effectsTruncated:effects.length>500,
      rawDialogueIncluded:false,tokenUsage:null,cost:null,costStatus:'not_recorded',historicalLinking:'Only explicit turn/action/request IDs are joined; legacy unlinked calls remain separate.'});
  });
}
