/* 提取路线与问卷特征，汇总旅行风格信号。 */

export const styleAlgorithm='travel-style/1';
const group=(prefix,labels)=>Object.entries(labels).map(([key,label])=>({key:prefix+'.'+key,label,group:prefix}));
export const styleDimensions=[
 ...group('interest',{museum:'博物馆',history:'历史文化',architecture:'建筑',oldtown:'古城古镇',garden:'园林',park:'城市公园',mountain:'山地自然',coast:'海滨',art:'艺术',food:'地方美食',shopping:'购物商场',night:'夜景',photo:'摄影',street:'街区漫游',family:'亲子游玩',quiet:'安静空间'}),
 ...group('destination',{urban:'都市',nature:'自然目的地',domestic:'国内',abroad:'境外',novelty:'探索新地方',revisit:'重游'}),
 ...group('pace',{relaxed:'慢节奏',balanced:'均衡节奏',full:'充实行程',short_stay:'短停留',long_stay:'深度停留',rests:'安排休息'}),
 ...group('mobility',{walking:'步行路线',transit:'公共交通',driving:'驾车',few_transfers:'少换乘',few_walking:'少走路'}),
 ...group('environment',{indoor:'室内',outdoor:'室外',uncrowded:'避开人群',lively:'接受热闹',famous:'知名景点',niche:'小众地点'}),
 ...group('food',{snacks:'小吃',meals:'正餐',coffee:'咖啡',local:'本地口味',convenient:'就近餐饮',vegetarian:'素食'}),
 ...group('stay',{hotel:'酒店',hostel:'青旅',homestay:'民宿',central:'市中心住宿',near_transit:'靠近交通'}),
 ...group('companion',{solo:'独自出游',couple:'双人出行',friends:'朋友同行',family:'家庭同行'}),
 ...group('format',{guide:'路线攻略',story:'游记',practical:'实用信息',short:'简短内容',detailed:'详细内容'}),
 ...group('budget',{economy:'节省预算',comfort:'舒适预算',premium:'高预算'}),
];
const known=new Set(styleDimensions.map(d=>d.key));
export const interestMap={人文:['interest.history','interest.museum'],自然:['interest.park','interest.mountain','interest.coast'],艺术:['interest.art'],美食:['interest.food','food.local'],园林:['interest.garden'],建筑:['interest.architecture'],夜景:['interest.night'],安静:['interest.quiet'],亲子:['interest.family'],街区:['interest.street','interest.oldtown']};
export function answerFeatures(answers={}){
 const values=featuresFromPlaces([],Array.isArray(answers.interests)?answers.interests:[]);
 const mappings={pace:{relaxed:'pace.relaxed',balanced:'pace.balanced',full:'pace.full'},transport:{fewTransfers:'mobility.few_transfers',fewWalking:'mobility.few_walking'},crowd:{avoid:'environment.uncrowded',lively:'environment.lively'},revisit:{new:'destination.novelty'}};
 for(const [key,options] of Object.entries(mappings))if(options[answers[key]])values[options[answers[key]]]=1;
 return values;
}
export function featuresFromPlaces(stops=[],tags=[]){
 const values={};for(const t of tags)for(const key of interestMap[t]||[])values[key]=1;
 for(const p of stops.slice(0,200)){
  const n=String(p.name||''),t=p.traits||{};
  const set=(key,yes)=>{if(yes)values[key]=Math.max(values[key]||0,.7);};
  set('interest.museum',/博物|纪念馆/.test(n)||t.tourism==='museum');
  set('interest.history',/故宫|故居|遗址|长城|古城|历史|纪念馆/.test(n)||p.category==='heritage');
  set('interest.art',/美术|艺术|画廊/.test(n)||t.tourism==='gallery');
  set('interest.architecture',/大楼|建筑|教堂|故居|城楼/.test(n));
  set('interest.oldtown',/古镇|古城|老街|胡同/.test(n));
  set('interest.garden',/园林|拙政园|留园|豫园/.test(n)||t.leisure==='garden');
  set('interest.park',/公园/.test(n)||t.leisure==='park');
  set('interest.coast',/海滨|沙滩|海滩/.test(n)||t.natural==='beach');
  set('interest.mountain',/山地|山峰|登山/.test(n)||['peak','waterfall'].includes(t.natural));
  set('interest.food',['dining','restaurant','food'].includes(p.category)||['restaurant','fast_food'].includes(t.amenity));
  set('interest.shopping',p.category==='shopping'||/商场|购物中心/.test(n));
  set('interest.street',/街区|步行街|胡同/.test(n));
  set('food.coffee',t.amenity==='cafe'||/咖啡/.test(n));
 }
 return values;
}
export function routeFeatures(snapshot={},tags=[]){
 const days=Array.isArray(snapshot.days)?snapshot.days.slice(0,31):[],stops=days.flatMap(d=>d.stops||[]).slice(0,200);
 return {values:featuresFromPlaces(stops,tags),cities:(snapshot.cities||[]).slice(0,5).map(c=>typeof c==='string'?c:c.name).filter(Boolean),
  facts:{dayCount:days.length,stopCount:stops.length,...(Number.isFinite(snapshot.distance_m)?{plannedDistanceM:snapshot.distance_m}:{})},algorithm:styleAlgorithm};
}
export function aggregateEvidence(rows,{now=Date.now(),window='long'}={}){
 const days=window==='short'?14:365,halfLife=window==='short'?7:90,groups=new Map();
 for(const r of rows){if(!known.has(r.dimension)||!Number.isFinite(r.value)||!Number.isFinite(r.weight))continue;
  const age=Math.max(0,(now-new Date(r.observed_at))/86400000);if(!Number.isFinite(age)||age>days)continue;
  const w=Math.max(0,Math.min(3,r.weight))*2**(-age/halfLife);if(!w)continue;
  const g=groups.get(r.dimension)||{sum:0,weight:0,sources:new Set()};g.sum+=Math.max(-1,Math.min(1,r.value))*w;g.weight+=w;g.sources.add(r.origin);groups.set(r.dimension,g);
 }
 return [...groups].map(([dimension,g])=>({dimension,value:Math.round(g.sum/g.weight*1000)/1000,strength:Math.min(1,g.weight/6),confidence:Math.min(.95,g.weight/(g.weight+4))*(g.sources.size===1?.65:1),samples:g.sources.size,window}));
}
export function planningStyle(rows,explicit={},current={}){
 const scores={};for(const tag of Object.keys(interestMap)){
  const xs=rows.filter(r=>interestMap[tag].includes(r.dimension)&&r.confidence>=.2);
  if(xs.length)scores[tag]=Math.max(-1,Math.min(1,xs.reduce((a,r)=>a+r.value*r.confidence,0)/xs.length));
 }
 return {...explicit,...current,styleWeights:scores,styleVersion:styleAlgorithm};
}
