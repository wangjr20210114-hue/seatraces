import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {digest,renderGradedReview} from './lib/graded-preference-review.mjs';
import {cosine} from '../server/recommendation/features.mjs';
import {profileText} from './lib/offline-semantic.mjs';
import {random} from '../server/recommendation/model.mjs';
if(process.argv.slice(2).join(' ')!=='--local'||process.env.NODE_ENV==='production')throw Error('Only --local');
const root=new URL('../validation/graded-preference-review/',import.meta.url);
try{await readFile(new URL('protocol-private.json',root));throw Error('Study already frozen');}catch(e){if(e.code!=='ENOENT')throw e;}
const raw=await readFile(new URL('../validation/ranking-diagnostic/input.json',import.meta.url),'utf8'),source=JSON.parse(raw);
const semanticRaw=await readFile(new URL('../validation/unisrec/input.json',import.meta.url),'utf8'),semantic=JSON.parse(semanticRaw);
if(source.inputSha256!==digest(semanticRaw)||source.activationAllowed!==false)throw Error('Frozen corpus mismatch');
const previous=JSON.parse(await readFile(new URL('../validation/preference-review/protocol-private.json',import.meta.url),'utf8'));
const excluded=new Set(previous.probes.flatMap(p=>p.postIds||[])),byId=new Map(source.posts.map(p=>[p.id,p])),used=new Set();
const rnd=random(2026101802),shuffle=list=>{const a=[...list];for(let i=a.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const tasks=[],probes=[];
for(const profile of [0,2,4,8,9]){
 const row=source.rows.find(r=>r.profile===profile);if(!row)throw Error('Missing fixed scenario');
 const all=semantic.posts.map((p,index)=>({index,post:byId.get(p.id),rule:cosine(row.userVector,source.rows.find(r=>r.postId===p.id).itemVector),semantic:cosine(semantic.profiles[profile].features.slice(96),p.features.slice(96))}));
 const rank=method=>new Map([...all].sort((a,b)=>b[method]-a[method]||a.post.id.localeCompare(b.post.id)).map((p,i)=>[p.post.id,i]));
 const ranks={rule:rank('rule'),semantic:rank('semantic')},routeUsed=new Set();
 const eligible=p=>!excluded.has(p.post.id)&&!used.has(p.post.id)&&!routeUsed.has(routeKey(p.post));
 function routeKey(p){const stops=(p.snapshot?.days||[]).flatMap(d=>d.stops||[]).map(s=>s.id||s.name);return stops.length?digest(stops):'post:'+p.id;}
 const take=(p,stratum)=>{
  used.add(p.post.id);routeUsed.add(routeKey(p.post));const id='g'+String(tasks.length+1).padStart(2,'0');
  const stops=(p.post.snapshot?.days||[]).flatMap(d=>d.stops||[]).map(s=>s.name);
  tasks.push({id,scenario:profileText(row.userVector).replace('为这个句子生成表示以用于检索相关文章：',''),title:p.post.title,body:p.post.body,tags:p.post.tags||[],route:stops.length?'路线：'+stops.join(' → '):''});
  probes.push({taskId:id,group:'profile-'+profile,profile,postId:p.post.id,postIndex:p.index,stratum,sourceRevision:p.post.revision});
 };
 let randomCount=0;for(const p of shuffle(all)){if(eligible(p)){take(p,'random');if(++randomCount===3)break;}}
 const disagreements=[...all].sort((a,b)=>Math.abs(ranks.rule.get(b.post.id)-ranks.semantic.get(b.post.id))-Math.abs(ranks.rule.get(a.post.id)-ranks.semantic.get(a.post.id))||a.post.id.localeCompare(b.post.id));
 let disagreementCount=0;for(const p of disagreements){if(eligible(p)){take(p,'disagreement');if(++disagreementCount===3)break;}}
 if(randomCount!==3||disagreementCount!==3)throw Error('Not enough unseen distinct candidates');
}
const primaryCount=tasks.length;for(const i of [2,12,22]){const original=tasks[i],id='g'+String(tasks.length+1).padStart(2,'0');tasks.push({...original,id});probes.push({taskId:id,repeatOf:original.id});}
const study={version:'seatraces-graded-review/1',primaryCount,tasks};study.protocolId=digest(study);
const protocol={protocolId:study.protocolId,createdAt:new Date().toISOString(),inputSha256:digest(raw),priorStudyExcluded:previous.protocolId,
 selection:'Seed 2026101802, five fixed existing scenarios; each 3 random without replacement plus 3 maximal rule/BGE-small rank disagreement, excluding old reviewed post IDs and within-scenario duplicate routes.',
 probes,activationAllowed:false,diagnosticOnly:true,trainingLabelsConsulted:false,
 limitations:['New judgments, not unseen training content.','Scenario judgments, not personal travel preferences.','Random and disagreement strata must be reported separately.','Repeated ratings do not add samples.','No actual adoption or satisfaction inferred from stated willingness.']};
await mkdir(root,{recursive:true});
for(const [name,value] of [['study.json',study],['protocol-private.json',protocol]])await writeFile(new URL(name,root),JSON.stringify(value,null,2),{flag:'wx'});
const client=await readFile(new URL('lib/graded-preference-client.js',import.meta.url),'utf8');
await writeFile(new URL('SeaTraces-旅行内容评价.html',root),renderGradedReview(study,client),{flag:'wx'});
console.log(JSON.stringify({protocolId:study.protocolId,primaryCount,repeats:tasks.length-primaryCount,random:15,disagreement:15,oldPostIdsExcluded:excluded.size,modelCalls:0,databaseWrites:0,activation:false}));
