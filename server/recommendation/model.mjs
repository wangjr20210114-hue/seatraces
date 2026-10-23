/* 定义推荐模型的编码、评分、训练和评估方法。 */

import {dot,validVector,clamp} from './features.mjs';
import {createHash} from 'node:crypto';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const artifactDigest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export const modelAlgorithm='two-tower-tanh-32/1';
export function random(seed=20261017){let x=seed>>>0;return()=>{x=(Math.imul(x,1664525)+1013904223)>>>0;return x/4294967296;};}
export const sigmoid=x=>1/(1+Math.exp(-clamp(x,-30,30)));
export function createTower(seed=1){const rnd=random(seed),matrix=()=>Array.from({length:32},()=>Array.from({length:96},()=>(rnd()-.5)*.35));return {algorithm:modelAlgorithm,inputVersion:'travel-content-96/1',user:matrix(),item:matrix(),bias:0};}
export function validateTower(m){return m?.algorithm===modelAlgorithm&&m.inputVersion==='travel-content-96/1'&&['user','item'].every(k=>Array.isArray(m[k])&&m[k].length===32&&m[k].every(r=>validVector(r)))&&Number.isFinite(m.bias)&&Math.abs(m.bias)<100;}
export function encode(m,kind,v){if(!validVector(v))throw Error('Invalid model feature vector');return m[kind].map(row=>Math.tanh(dot(row,v)));}
export function towerScore(m,u,p){return sigmoid(dot(encode(m,'user',u),encode(m,'item',p))/Math.sqrt(32)+m.bias);}
export function trainTower(samples,{seed=7,epochs=18,rate=.025}={}){
 if(samples.length<20||samples.length>20000)throw Error('Training sample count outside 20..20000');
 if(samples.some(s=>!validVector(s.user)||!validVector(s.item)||![0,1].includes(s.label)))throw Error('Invalid training samples');
 const m=createTower(seed),rnd=random(seed+1),indices=samples.map((_,i)=>i),history=[];
 for(let epoch=0;epoch<epochs;epoch++){
  for(let i=indices.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[indices[i],indices[j]]=[indices[j],indices[i]];}
  let loss=0;const lr=rate/(1+epoch*.04);
  for(const i of indices){const s=samples[i],u=encode(m,'user',s.user),p=encode(m,'item',s.item),prob=sigmoid(dot(u,p)/Math.sqrt(32)+m.bias),w=clamp(s.weight??1,.1,5),err=(prob-s.label)*w;
   loss-=w*(s.label*Math.log(prob+1e-8)+(1-s.label)*Math.log(1-prob+1e-8));
   for(let h=0;h<32;h++){const du=err*p[h]*(1-u[h]**2)/Math.sqrt(32),dp=err*u[h]*(1-p[h]**2)/Math.sqrt(32);
    for(let k=0;k<96;k++){m.user[h][k]-=lr*(du*s.user[k]+.0001*m.user[h][k]);m.item[h][k]-=lr*(dp*s.item[k]+.0001*m.item[h][k]);}}
   m.bias-=lr*err;
  }
  history.push(loss/samples.length);
 }
 if(!validateTower(m))throw Error('Training produced invalid weights');
 return {model:m,loss:history};
}
export function rankInputs({coarse=0,affinity=0,author=0,fresh=0,quality=0,city=0,seen=0,tower=0}){
 return [clamp(coarse/5),affinity,clamp(author/3),fresh,quality,city,seen,tower,affinity*city,quality*affinity,1];
}
export function rankScore(m,features){return sigmoid(dot(m.weights,features));}
export function trainRanker(samples,{epochs=80,rate=.06}={}){
 const m={algorithm:'crossed-logistic/1',weights:Array(11).fill(0)};
 for(let e=0;e<epochs;e++)for(const s of samples){const err=(rankScore(m,s.features)-s.label)*clamp(s.weight??1,.1,5);for(let i=0;i<11;i++)m.weights[i]-=rate/(1+e*.05)*(err*s.features[i]+.001*m.weights[i]);}
 return m;
}
export function rankingMetrics(groups,score,k=10){
 let recall=0,ndcg=0,n=0;
 for(const group of groups){const relevant=group.filter(s=>s.label===1).length;if(!relevant)continue;
  const sorted=group.map((s,i)=>({s,i,score:score(s)})).sort((a,b)=>b.score-a.score||a.i-b.i).slice(0,k);
  const hits=sorted.filter(r=>r.s.label===1).length;recall+=hits/relevant;
  const dcg=sorted.reduce((sum,r,i)=>sum+(r.s.label?1/Math.log2(i+2):0),0),ideal=Array.from({length:Math.min(k,relevant)},(_,i)=>1/Math.log2(i+2)).reduce((a,b)=>a+b,0);
  ndcg+=dcg/ideal;n++;
 }
 return {groups:n,recallAtK:n?recall/n:0,ndcgAtK:n?ndcg/n:0,k};
}
