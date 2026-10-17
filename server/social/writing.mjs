import {z} from 'zod';
import {llmJSON} from '../integrations/deepseek.mjs';
import {failure,ownedDraft,assertDraftVersion} from './drafts.mjs';

export function writingFacts(draft){
 const days=Array.isArray(draft.snapshot?.days)?draft.snapshot.days:[];
 return days.slice(0,31).map((day,i)=>({id:'day-'+i,city:String(day.city||'目的地').slice(0,80),
  stops:(day.stops||[]).slice(0,30).map(p=>String(p.name||'').slice(0,100)).filter(Boolean)})).filter(d=>d.stops.length);
}
// The model chooses an editorial arrangement of verified facts, not new facts.
// Free-form facts supplied by the model (prices, visits, opening hours) cannot
// reach the published draft. The user remains free to write their own prose.
export function composeSuggestion(draft,decision){
 const facts=writingFacts(draft);
 const b=z.object({tone:z.enum(['lively','concise','guide']),highlightIds:z.array(z.string()).max(8),ending:z.enum(['save','question','none'])}).strict().parse(decision);
 if(new Set(b.highlightIds).size!==b.highlightIds.length||b.highlightIds.some(id=>!facts.some(f=>f.id===id)))throw failure('模型引用了不存在的行程，未修改草稿',502);
 const cities=[...new Set(facts.map(f=>f.city))].join(' · ');
 const title=(`${cities||'我的旅行'}｜${b.tone==='lively'?'把想去的地方串起来 ✨':b.tone==='guide'?'一份路线安排':'下一程路线'}`).slice(0,100);
 const intro=b.tone==='lively'?'把期待装进行程里，下一程这样安排 ✨':b.tone==='guide'?'整理了一份路线安排，出发前可以参考：':'这份行程准备这样走：';
 const lines=facts.map((f,i)=>`${b.highlightIds.includes(f.id)?'📍 ':''}Day ${i+1} · ${f.city}\n${f.stops.join(' → ')}`);
 const ending={save:'先收好这份路线，等出发时再确认开放与交通。',question:'你还想把哪里加入这条路线？',none:''}[b.ending];
 const body=[intro,...lines,ending].filter(Boolean).join('\n\n');
 if(body.length>4000)throw failure('路线较长，请手动精简分享内容',400);
 return {title,body,tags:[...new Set(facts.map(f=>f.city))].filter(x=>x.length<=20).slice(0,8),source:'route_facts',requiresReview:true};
}
export function installWritingRoutes(app,{auth,query,transaction,generate=llmJSON}){
 let active=0;
 const jobs=new Set();
 app.post('/api/social/drafts/:id/generate',auth,async(req,res)=>{
  const b=z.object({id:z.uuid(),version:z.number().int().min(1),tone:z.enum(['lively','concise','guide']).default('lively')}).strict().parse(req.body);
  const existing=(await query('SELECT id,state FROM social_ai_jobs WHERE id=$1 AND user_id=$2 AND draft_id=$3',[b.id,req.user.id,z.uuid().parse(req.params.id)])).rows[0];
  if(existing)return res.json(existing);
  if(active>=2)throw failure('AI 正在整理其他内容，请稍后重试',429);active++;
  let draft;
  try{draft=await transaction(async c=>{
   await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
   const replay=(await c.query('SELECT id,user_id,draft_id,state FROM social_ai_jobs WHERE id=$1',[b.id])).rows[0];
   if(replay){if(replay.user_id!==req.user.id||replay.draft_id!==req.params.id)throw failure('生成任务不存在',404);return {replay:{id:replay.id,state:replay.state}};}
   const d=await ownedDraft(c,req.params.id,req.user.id,true);assertDraftVersion(d,b.version);
   if(!writingFacts(d).length)throw failure('请先关联一条行程，再生成路线文案');
   if((await c.query("SELECT id FROM social_ai_jobs WHERE user_id=$1 AND created_at>now()-interval '10 minutes'",[req.user.id])).rowCount>=3)throw failure('已连续生成 3 次，请稍后再试',429);
   await c.query("UPDATE social_ai_jobs SET state='failed',error='生成中断，请重新生成',finished_at=now() WHERE state='running' AND created_at<now()-interval '3 minutes'");
   if((await c.query("SELECT id FROM social_ai_jobs WHERE draft_id=$1 AND state='running'",[d.id])).rowCount)throw failure('这份草稿正在生成，请稍候',409);
   await c.query("INSERT INTO social_ai_jobs(id,user_id,draft_id,draft_version,state) VALUES($1,$2,$3,$4,'running')",[b.id,req.user.id,d.id,d.version]);return d;
  });}catch(e){active--;throw e;}
  if(draft.replay){active--;return res.json(draft.replay);}
  const task=(async()=>{
   try{
    const result=await generate('为旅行分享草稿选择呈现方式。仅返回 {tone:"lively"|"concise"|"guide",highlightIds:[已提供的 day ID，最多8个],ending:"save"|"question"|"none"}。不生成自由文本，不声称已到访。',{facts:writingFacts(draft),requestedTone:b.tone},{maxTokens:500});
    const suggestion=composeSuggestion(draft,result);
    await query("UPDATE social_ai_jobs SET state='ready',result=$2,finished_at=now() WHERE id=$1 AND state='running'",[b.id,JSON.stringify(suggestion)]);
   }catch{await query("UPDATE social_ai_jobs SET state='failed',error='生成暂未完成，请重试或手动编写',finished_at=now() WHERE id=$1 AND state='running'",[b.id]).catch(()=>{});}
   finally{active--;}
  })();jobs.add(task);void task.finally(()=>jobs.delete(task));res.status(202).json({id:b.id,state:'running'});
 });
 app.get('/api/social/writing/:id',auth,async(req,res)=>{
  const j=(await query('SELECT id,state,result,error,draft_version,created_at FROM social_ai_jobs WHERE id=$1 AND user_id=$2',[z.uuid().parse(req.params.id),req.user.id])).rows[0];
  if(!j)throw failure('生成任务不存在',404);
  if(j.state==='running'&&Date.now()-new Date(j.created_at)>180000){j.state='failed';j.error='生成中断，请重试';}
  res.json(j);
 });
 return {drain:()=>Promise.allSettled([...jobs])};
}
