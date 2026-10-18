// Post-hoc diagnostics only: never train on, rewrite, or relabel human answers.
import {readFile,writeFile} from 'node:fs/promises';
import {digest} from './lib/offline-semantic.mjs';
import {formatText,cosine} from './experiment-travel-embeddings.mjs';
if(process.argv.slice(2).join(' ')!=='--local'||process.env.NODE_ENV==='production')throw Error('Only --local allowed');
const root=new URL('../validation/travel-models/',import.meta.url),review=new URL('../validation/preference-review/',import.meta.url);
const load=async url=>JSON.parse(await readFile(url,'utf8'));
const data=await load(new URL('../validation/unisrec/input.json',import.meta.url)),texts=await load(new URL('texts.json',root));
const study=await load(new URL('study.json',review)),protocol=await load(new URL('protocol-private.json',review)),analysis=await load(new URL('analysis.json',review));
const {protocolId,...base}=study;
if(digest(base)!==protocolId||protocol.protocolId!==protocolId||analysis.protocolId!==protocolId||analysis.reviewerCount!==1||analysis.primaryQuestionCount!==20)throw Error('Expected frozen single-reviewer diagnostic');
const semantic={};
for(const name of ['bge-base','e5-small']){
  const report=await load(new URL(name+'-report.json',root));
  if(report.status!=='completed'||report.activationAllowed!==false||report.textsSha256!==digest(await readFile(new URL('texts.json',root),'utf8')))throw Error('Encoder not completed with the same texts');
  const cached=async(text,query)=>{
    const key=digest({fixed:report.spec,text:formatText(text,query,report.spec)}),record=await load(new URL('vectors-'+name+'/'+key+'.json',root));
    if(record.key!==key||record.vector.length!==report.spec.dimensions)throw Error('Vector mismatch');
    return record.vector;
  };
  semantic[name]={posts:await Promise.all(texts.posts.map(p=>cached(p.text,false))),profiles:await Promise.all(texts.profiles.map(p=>cached(p.text,true)))};
}
const results=[];
for(const probe of protocol.probes.filter(p=>!p.repeatOf)){
  const task=study.tasks.find(t=>t.id===probe.taskId),vote=analysis.tasks.find(t=>t.taskId===task.id);
  const profile=texts.profiles.findIndex(p=>p.text.replace(/^为这个句子生成表示以用于检索相关文章：/,'')===task.scenario);
  const indexes=probe.postIds.map(id=>data.posts.findIndex(p=>p.id===id));
  if(profile<0||indexes.some(i=>i<0)||vote.tasks!==1)throw Error('Unmatched scenario/item/answer');
  const outcome=vote.firstMethodWins===1?0:vote.secondMethodWins===1?1:vote.both===1?'both':vote.neither===1?'neither':'unsure';
  const scores={rule:indexes.map(i=>cosine(data.profiles[profile].features.slice(0,96),data.posts[i].features.slice(0,96)))};
  for(const [name,v] of Object.entries(semantic))scores[name]=indexes.map(i=>cosine(v.profiles[profile],v.posts[i]));
  results.push({taskId:task.id,profile,posts:indexes,outcome,scores});
}
const counts={relative:results.filter(r=>Number.isInteger(r.outcome)).length,both:results.filter(r=>r.outcome==='both').length,neither:results.filter(r=>r.outcome==='neither').length};
const models={};
for(const name of ['rule','bge-base','e5-small']){
  const single=results.filter(r=>Number.isInteger(r.outcome));
  models[name]={matched:single.filter(r=>r.scores[name][r.outcome]>r.scores[name][1-r.outcome]+1e-9).length,tied:single.filter(r=>Math.abs(r.scores[name][0]-r.scores[name][1])<=1e-9).length,total:single.length};
}
const report={activationAllowed:false,analysisTiming:'post_hoc',protocolId,reviewers:1,counts,models,results,
  inputSha256:digest(await readFile(new URL('../validation/unisrec/input.json',import.meta.url),'utf8')),
  limitation:'Eight relative preferences from one reviewer on selected familiar synthetic content. Both/neither are not forced ranking labels. Not NDCG, not an independent holdout, no training or activation.'};
await writeFile(new URL('blind-semantic.json',root),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({counts,models,activationAllowed:false}));
