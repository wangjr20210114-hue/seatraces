/* 提取内容特征，将地点与用户兴趣转换为向量。 */

import {createHash} from 'node:crypto';
import {styleDimensions,featuresFromPlaces,interestMap} from '../social/features.mjs';
export const algorithm='recommendation/2';
export const vectorVersion='travel-content-96/1';
export const dimensionKeys=styleDimensions.map(d=>d.key);
export const weights=Object.freeze({view:.3,comment:.5,like:1,recommend:2,follow:2,save:3,adopt_intent:1,adopt:4,satisfaction:5,not_interested:4});
export const clamp=(x,min=-1,max=1)=>Math.max(min,Math.min(max,Number.isFinite(x)?x:0));
const lexicon={
 'interest.museum':/博物|展馆|展览/,'interest.history':/历史|遗址|古迹|故宫|故居|长城|文物/,
 'interest.architecture':/建筑|教堂|城楼|骑楼/,'interest.oldtown':/古城|古镇|胡同|老街/,
 'interest.garden':/园林|拙政园|留园|豫园/,'interest.park':/公园|绿道/,'interest.mountain':/爬山|登山|山顶|山野/,
 'interest.coast':/海边|海滨|沙滩|海岸/,'interest.art':/艺术|画廊|美术|雕塑/,'interest.food':/美食|小吃|餐厅|面馆/,
 'interest.shopping':/商场|购物|市集/,'interest.night':/夜景|夜游|灯光/,'interest.photo':/摄影|拍照|机位/,
 'interest.street':/街区|街巷|CityWalk|citywalk|漫步/,'interest.family':/亲子|带娃/,'interest.quiet':/安静|清静/,
 'environment.indoor':/室内|展馆/,'environment.outdoor':/户外|露天|绿道/,
 'food.coffee':/咖啡/,'food.local':/当地口味|本地小吃/,'food.snacks':/小吃/,'food.vegetarian':/素食|素菜/,
 'format.guide':/攻略|路线|怎么走|避坑/,'format.story':/随记|日记|散记/,'format.practical':/提醒|建议|注意|预约/,
};
export function contentFeatures(post){
 const snapshot=post.snapshot||{},days=Array.isArray(snapshot.days)?snapshot.days.slice(0,31):[];
 const stops=Array.isArray(post.stops)?post.stops.slice(0,200):days.flatMap(d=>d.stops||[]).slice(0,200);
 const text=String(post.title||'').slice(0,100)+' '+String(post.body||'').slice(0,4000);
 const values=featuresFromPlaces(stops,post.tags||[]);
 for(const [key,pattern] of Object.entries(lexicon))if(pattern.test(text))values[key]=Math.max(values[key]||0,.6);
 values[text.length>700?'format.detailed':'format.short']=.7;
 const cities=[...new Set((post.cities||snapshot.cities||[]).map(c=>typeof c==='string'?c:c?.name).filter(Boolean))].slice(0,5);
 const facts={dayCount:post.day_count??days.length,stopCount:stops.length,
  distanceM:Number.isFinite(snapshot.distance_m)?Math.max(0,snapshot.distance_m):null};
 const routeIds=stops.map(p=>p.id).filter(Boolean).sort();
 return {values,cities,facts,quality:clamp((text.length/800+(stops.length?1:0)+(post.tags?.length?1:0))/3,0,1),
  routeKey:routeIds.length?createHash('sha256').update(routeIds.join('|')).digest('hex').slice(0,24):null,
  algorithm,vectorVersion};
}
const cityIndex=s=>createHash('sha256').update(String(s).replace(/市$/,'')).digest()[0]%16;
export function vectorize(values={},cities=[],facts={}){
 const v=Array(96).fill(0);
 dimensionKeys.forEach((key,i)=>{v[i]=clamp(values[key]);});
 for(const c of cities.slice(0,5))v[62+cityIndex(c)]=.6;
 if(Number.isFinite(facts.dayCount))v[78]=Math.min(1,facts.dayCount/14);
 if(Number.isFinite(facts.stopCount))v[79]=Math.min(1,facts.stopCount/30);
 if(Number.isFinite(facts.distanceM))v[80]=Math.min(1,facts.distanceM/15000);
 v[95]=.1;
 return v;
}
export function profileVector(profile,explicit={},context={}){
 const values={};
 for(const [group,weight] of [[profile.travel||{},.65],[profile.content||{},.35]])for(const [key,r] of Object.entries(group)){
  const long=r.long,short=r.short;
  if(long||short)values[key]=clamp((values[key]||0)+weight*((long?.value||0)*(long?.confidence||0)*.65+(short?.value||0)*(short?.confidence||0)*.35));
 }
 for(const t of explicit.interests||[])for(const key of interestMap[t]||[])values[key]=1;
 return vectorize(values,context.city?[context.city]:[]);
}
export function dot(a,b){let n=0;for(let i=0;i<Math.min(a.length,b.length);i++)n+=a[i]*b[i];return n;}
export function cosine(a,b){const d=Math.sqrt(dot(a,a)*dot(b,b));return d?clamp(dot(a,b)/d):0;}
export function validVector(v,n=96){return Array.isArray(v)&&v.length===n&&v.every(x=>Number.isFinite(x)&&Math.abs(x)<=100);}
