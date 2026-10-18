import {createHash} from 'node:crypto';
export const digest=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export const dimensions=['read','save','adopt'];
export const ratings=['no','maybe','yes','unknown'];
export function validateGradedAnswers(study,input){
 if(!input||input.protocolId!==study.protocolId||!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(input.reviewerId||'')||!Array.isArray(input.responses)||input.responses.length!==study.tasks.length)throw Error('Invalid study identity or incomplete answers');
 const allowed=new Set(study.tasks.map(t=>t.id)),seen=new Set();
 const responses=input.responses.map(r=>{
  if(!r||!allowed.has(r.taskId)||seen.has(r.taskId)||!r.ratings||Object.keys(r.ratings).sort().join(',')!==[...dimensions].sort().join(',')||dimensions.some(k=>!ratings.includes(r.ratings[k]))||!Number.isFinite(r.elapsedMs)||r.elapsedMs<0||r.elapsedMs>86400000)throw Error('Invalid answer');
  seen.add(r.taskId);return {taskId:r.taskId,ratings:Object.fromEntries(dimensions.map(k=>[k,r.ratings[k]])),elapsedMs:r.elapsedMs};
 });
 return {protocolId:study.protocolId,reviewerId:input.reviewerId.toLowerCase(),responses};
}
export function summarizeGraded(study,protocol,inputs){
 if(protocol.protocolId!==study.protocolId||protocol.probes.length!==study.tasks.length||new Set(protocol.probes.map(p=>p.taskId)).size!==study.tasks.length||protocol.probes.some(p=>!study.tasks.some(t=>t.id===p.taskId)))throw Error('Protocol mismatch');
 if(!Array.isArray(inputs)||inputs.length>1000)throw Error('Answer bound');
 const reviewers=new Set(),byTask=new Map(),strata={};let repeatComparisons=0,repeatAgreements=0;
 for(const input of inputs){
  const answer=validateGradedAnswers(study,input);if(reviewers.has(answer.reviewerId))throw Error('Select one final submission per reviewer');reviewers.add(answer.reviewerId);
  const byId=new Map(answer.responses.map(r=>[r.taskId,r]));
  for(const p of protocol.probes){
   const r=byId.get(p.taskId);
   if(p.repeatOf){if(!byId.has(p.repeatOf))throw Error('Missing repeat source');for(const d of dimensions){repeatComparisons++;repeatAgreements+=r.ratings[d]===byId.get(p.repeatOf).ratings[d];}continue;}
   const row=byTask.get(p.taskId)||{taskId:p.taskId,stratum:p.stratum,group:p.group,ratings:Object.fromEntries(dimensions.map(d=>[d,Object.fromEntries(ratings.map(v=>[v,0]))]))};
   const counts=strata[p.stratum]??=Object.fromEntries(dimensions.map(d=>[d,Object.fromEntries(ratings.map(v=>[v,0]))]));
   for(const d of dimensions){row.ratings[d][r.ratings[d]]++;counts[d][r.ratings[d]]++;}byTask.set(p.taskId,row);
  }
 }
 return {protocolId:study.protocolId,status:reviewers.size?'diagnostic_ready':'awaiting_reviews',reviewerCount:reviewers.size,strata,tasks:[...byTask.values()],repeatComparisons,repeatAgreements,
  diagnosticOnly:true,activationAllowed:false,limitation:'Scenario-conditioned independent dimension ratings. Unknown is missing, not negative. Repeats excluded. Synthetic content previously available to models; not unseen-content generalization or actual adoption.'};
}
export function compareGraded(study,protocol,frozen,inputs){
 const basic=summarizeGraded(study,protocol,inputs),primary=protocol.probes.filter(p=>!p.repeatOf),methods=['cosine','fineRule','lightgbm','bgeSmall'];
 if(frozen.protocolId!==study.protocolId||frozen.activationAllowed!==false||frozen.predictions?.length!==primary.length)throw Error('Frozen predictions mismatch');
 const predictions=new Map(frozen.predictions.map(p=>[p.taskId,p.scores]));
 if(predictions.size!==primary.length||primary.some(p=>!predictions.has(p.taskId)||methods.some(m=>!Number.isFinite(predictions.get(p.taskId)[m]))))throw Error('Missing frozen predictions');
 const gain={no:0,maybe:1,yes:2},results=[];
 for(const dimension of dimensions)for(const stratum of ['random','disagreement']){
  const byMethod=Object.fromEntries(methods.map(m=>[m,[]]));let groups=0,unknownExcluded=0,insufficientGroups=0;
  for(const input of inputs){
   const valid=validateGradedAnswers(study,input),answers=new Map(valid.responses.map(r=>[r.taskId,r.ratings[dimension]])),byGroup=new Map();
   for(const p of primary.filter(p=>p.stratum===stratum)){const group=byGroup.get(p.group)||[];group.push(p);byGroup.set(p.group,group);}
   const userValues=Object.fromEntries(methods.map(m=>[m,[]]));
   for(const group of byGroup.values()){
    const rated=group.filter(p=>answers.get(p.taskId)!=='unknown');unknownExcluded+=group.length-rated.length;
    const ideal=rated.map(p=>gain[answers.get(p.taskId)]).sort((a,b)=>b-a).slice(0,3),denominator=ideal.reduce((n,g,i)=>n+g/Math.log2(i+2),0);
    if(rated.length<2||!denominator){insufficientGroups++;continue;}groups++;
    for(const method of methods){const ranked=[...rated].sort((a,b)=>predictions.get(b.taskId)[method]-predictions.get(a.taskId)[method]||a.taskId.localeCompare(b.taskId));userValues[method].push(ranked.slice(0,3).reduce((n,p,i)=>n+gain[answers.get(p.taskId)]/Math.log2(i+2),0)/denominator);}
   }
   for(const m of methods)if(userValues[m].length)byMethod[m].push(userValues[m].reduce((a,b)=>a+b,0)/userValues[m].length);
  }
  results.push({dimension,stratum,groups,unknownExcluded,insufficientGroups,reviewersWithEvidence:byMethod.cosine.length,
   ndcgAt3:Object.fromEntries(methods.map(m=>[m,byMethod[m].length?byMethod[m].reduce((a,b)=>a+b,0)/byMethod[m].length:null]))});
 }
 return {protocolId:study.protocolId,reviewerCount:basic.reviewerCount,results,diagnosticOnly:true,activationAllowed:false,
  aggregation:'Average scenarios within each reviewer, then reviewers. Each dimension and selection stratum separate. Null means insufficient data. No significance or actual adoption claim.'};
}
export function renderGradedReview(study,client){
 const safe=JSON.stringify(study).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SeaTraces · 旅行内容评价</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<style>*{box-sizing:border-box}body{margin:0;background:#f3f7f8;color:#163e43;font:16px/1.65 system-ui,sans-serif}main{max-width:850px;margin:auto;padding:28px 20px 70px}h1{font-size:27px;margin:0}h2{font-size:22px}p{margin:10px 0}button{font:inherit;color:inherit;padding:10px 16px;background:white;border:1px solid #a6bfc4;border-radius:10px;cursor:pointer}button:hover{border-color:#087d70}button:disabled{opacity:.45;cursor:default}button[aria-pressed=true],.primary{background:#087d70;color:white;border-color:#087d70}section,article{padding:22px;background:white;border-radius:18px;border:1px solid #dbe6e8;margin:18px 0}.scenario{background:#fff5d8;border-left:5px solid #edbb46}.body{white-space:pre-wrap;overflow-wrap:anywhere}.muted{font-size:14px;color:#52696e}.nav,.choices{display:flex;flex-wrap:wrap;gap:9px;margin:12px 0}.nav{justify-content:space-between}fieldset{border:0;border-top:1px solid #dbe6e8;margin:12px 0 0;padding:15px 0 0}legend{font-weight:650;padding-right:10px}.progress{height:6px;background:#dce9e7;border-radius:8px}.progress i{display:block;height:100%;background:#1aa28e;border-radius:8px}#status{min-height:28px}[hidden]{display:none!important}@media(max-width:600px){main{padding:20px 12px 60px}section,article{padding:17px}button{padding:10px 13px}}</style>
<main><h1>SeaTraces · 旅行内容评价</h1><section id="intro"><h2>这篇内容，值得看、收藏或照着走吗？</h2><p>按每题给出的旅行偏好，分别回答三个问题。它们互相独立：可以喜欢看，但不想收藏或出行。</p><p>内容来自项目模拟帖子，不是真实游记。未提供预算、开放时间或实际路况时，请选“信息不足”，不要补充假设。全部选“愿意”或“不愿意”也可以，没有标准答案。</p><p class="muted">30 篇评价＋3 篇重复检查，约 10～15 分钟。不显示算法分数。无登录、无联网；答案只在此浏览器暂存，完成后下载。请独立作答。</p><button id="start" class="primary">开始 / 继续</button></section>
<section id="review" hidden><div class="progress"><i id="bar"></i></div><p id="count" class="muted"></p><div class="scenario"><strong>本题旅行偏好</strong><p id="scenario"></p></div><article><h2 id="title"></h2><p id="tags" class="muted"></p><p id="body" class="body"></p><p id="route" class="muted"></p></article><div id="ratings"></div><div class="nav"><button id="back">上一篇</button><button id="next" class="primary">下一篇</button></div></section>
<section id="done" hidden><h2>已完成，谢谢！</h2><p>下载答案文件并交回负责人。结果不自动写入旅行画像，也不会自动启用模型。</p><div class="choices"><button id="download" class="primary">下载答案 JSON</button><button id="revise">检查答案</button></div></section><p id="status" role="status" aria-live="polite"></p></main>
<script id="study-data" type="application/json">${safe}</script><script>${client}</script></html>`;
}
