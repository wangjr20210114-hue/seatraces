/* 检查 AI 对话、操作预览和确认流程。 */

import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
const base='http://127.0.0.1:8793',username='agent_check_'+randomBytes(5).toString('hex');
let cookie='',userId,conversationId,revision=0;
const report={startedAt:new Date().toISOString(),base,steps:[],productionTouched:false};
async function request(path,body,method) {
 const r=await fetch(base+path,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Seatraces':'1',Cookie:cookie},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(115000)});
 const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const data=await r.json();
 if(!r.ok)throw Object.assign(Error(data.error||String(r.status)),{status:r.status});return data;
}
async function send(text,optionIds,questionId) {
 const r=await request(`/api/agent/conversations/${conversationId}/messages`,{requestId:randomUUID(),revision,text,...(optionIds?{optionIds,questionId}:{})});revision=r.revision;
 report.steps.push({kind:r.question?.key||r.action?.effect||r.intent,error:r.error||false});
 if(r.error)throw Error(r.text);return r;
}
async function confirm(action) {
 const r=await request(`/api/agent/conversations/${conversationId}/actions/${action.id}`,{requestId:randomUUID(),revision,decision:'confirm'});revision=r.revision;
 report.steps.push({kind:'confirmation',status:r.actionResult?.status});if(r.error)throw Error(r.text);return r;
}
try{
 userId=(await request('/api/auth/register',{username,password:randomBytes(24).toString('hex'),nickname:'智能体验收'})).user.id;
 const c=await request('/api/agent/conversations',{});conversationId=c.id;
 const knowledge=await send('怎么规划行程？');report.knowledge={retrieval:knowledge.retrieval,sources:knowledge.sources?.map(s=>s.id),version:knowledge.knowledgeVersion};
 let r=await send('帮我规划一次旅行'),polls=0;
 for(let i=0;i<40;i++) {
  if(r.action){r=await confirm(r.action);if(r.tripId){report.tripGenerated=true;const t=await request('/api/trips/'+r.tripId);report.days=t.plan.days.map(d=>({date:d.date,city:d.city,stops:d.stops.length}));break;}continue;}
  const q=r.question;if(!q)throw Error('Expected question');
  const texts={originName:'上海',destinationName:'苏州',start:'2026-10-20',end:'2026-10-21'};
  if(texts[q.key]){r=await send(texts[q.key]);continue;}
  if(q.key==='retryCity'){if(++polls>15)throw Error('City catalog is still loading');await new Promise(resolve=>setTimeout(resolve,1800));}
  let o=q.options[0];
  if(q.key==='origin')o=q.options.find(o=>o.label.startsWith('上海 ·'))||o;
  if(q.key==='city')o=q.options.find(o=>o.label.startsWith('苏州 ·'))||o;
  if(q.key==='preference')o=q.options.find(o=>/均衡|刚刚好|综合推荐|都可以|探索新地方/.test(o.label))||o;
  r=await send('',[o.id],q.id);
 }
 if(!report.tripGenerated)throw Error('No trip returned');
 report.status='passed';
}catch(e){report.status='blocked';report.reason=e.message;}
finally{
 if(userId){const local=JSON.parse(await readFile('.runtime/local.json','utf8'));const db=new pg.Client({host:'127.0.0.1',port:local.port,user:'seatraces',password:local.password,database:'seatraces'});try{await db.connect();await db.query('DELETE FROM users WHERE id=$1 AND username=$2',[userId,username]);report.testAccountRemoved=true;}finally{await db.end();}}
 report.finishedAt=new Date().toISOString();await mkdir('validation/agent',{recursive:true});await writeFile('validation/agent/live-check.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
