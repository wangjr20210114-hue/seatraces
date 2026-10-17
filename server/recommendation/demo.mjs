import {createHash,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {random} from './model.mjs';
import {contentFeatures,vectorize,profileVector,cosine,algorithm} from './features.mjs';
import {refreshItem,buildProfile} from './profiles.mjs';
import {rebuildStyle} from '../social/style-store.mjs';
import {coarseFeatures} from './engine.mjs';
export const demoAlgorithm='fictional-community/1';
const names=['林小满','陈予安','周末的阿宁','许知夏','李沐阳','赵一禾','沈星野','宋晚晴','吴小川','郑予墨','何清欢','高知远','陆南枝','苏慢慢','黄可欣','江望舒','顾行舟','白茶与路','徐向晚','程见山','罗亦然','唐青禾','王书宁','韩子衿','杨遇晴','谢云帆','秦若溪','彭知南','蒋庭安','田小雨','叶拾光','方听澜','梁初晴','蔡念一','魏星河','马知遥','夏之遥','杜若林','钟明悦','卢小鹿','石与海','冯听风','袁慕白','许步步','周以宁','林溪午后','丁小舟','陈看山','邓望野','陶时雨'];
const handles=['linxiaoman','chenyuan','anning_walk','xuzhixia','limuyang','zhaoyihe','shenxingye','songwanqing','wuxiaochuan','zhengyumo'];
const styles=[
 {name:'博物馆笔记',tags:['人文'],keywords:['博物','纪念','故居'],voice:'guide',format:'format.practical'},
 {name:'周末园林',tags:['园林','安静'],keywords:['园','湖'],voice:'quiet',format:'format.story'},
 {name:'街头建筑',tags:['建筑','街区'],keywords:['建筑','外滩','桥','街'],voice:'photo',format:'format.detailed'},
 {name:'带娃慢走',tags:['亲子','自然'],keywords:['公园','湖','园'],voice:'family',format:'format.practical'},
 {name:'咖啡与街区',tags:['美食','街区'],keywords:['街','路','桥'],voice:'casual',format:'format.short'},
 {name:'艺术散步',tags:['艺术'],keywords:['美术','艺术','博物'],voice:'art',format:'format.story'},
 {name:'城市夜色',tags:['夜景','建筑'],keywords:['桥','塔','外滩','湖'],voice:'night',format:'format.short'},
 {name:'清晨户外',tags:['自然','安静'],keywords:['湖','公园','山'],voice:'outdoor',format:'format.guide'},
 {name:'古城拾遗',tags:['人文','街区'],keywords:['故','古','胡同','街'],voice:'history',format:'format.detailed'},
 {name:'随性一日',tags:['街区','美食'],keywords:['街','路','园'],voice:'list',format:'format.guide'},
];
const openings={guide:['这次把路线拆成了几个小段。','先记顺序，再慢慢看沿途。','把攻略写短一点，方便出门前翻。'],quiet:['今天不想赶路，只想给自己留点空白。','走慢一点，风景会多一点。','没有塞满日程的一天，反而记得更清楚。'],photo:['这次带着相机，沿路找光影。','比起打卡照，我更喜欢街角的小画面。','拍照不是目的，观察城市才是。'],family:['带孩子出门，少安排一站也没关系。','这条路线按一家人的节奏来走。','中途留够休息，才有心情看风景。'],casual:['周末不用走很远，挑一小片街区就好。','和朋友边走边聊，路线只是一个起点。','想喝咖啡的时候停一下，不赶下一站。'],art:['把散步当成一场小型观察练习。','今天的主题是颜色、线条和留白。','展览之外，街上也有很多细节。'],night:['天色慢慢暗下来，城市换了一种表情。','留一点时间给夜色，别急着回去。','这次想看的，是灯光亮起后的街道。'],outdoor:['清晨出门，给脚步和呼吸一点空间。','今天想在户外多待一会儿。','沿路的绿意，比完成清单更重要。'],history:['老街的故事，适合一段一段读。','看过地图以后，更想了解地名背后的故事。','比起赶路，我愿意多看一眼门口的介绍。'],list:['整理一条可以随时删减的周末清单。','不追求全部走完，只挑自己喜欢的部分。','路线先串起来，时间留给现场决定。']};
function uuid(seed,label){const h=createHash('sha256').update(seed+':'+label).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
export async function generateDemo({seed=20261017,now=Date.now()}={}){
 const rnd=random(seed),pick=a=>a[Math.floor(rnd()*a.length)],routes=JSON.parse(await readFile(new URL('../data/classic-citywalks.json',import.meta.url),'utf8'));
 const batchId=uuid(seed,'batch'),users=names.map((nickname,i)=>({id:uuid(seed,'user:'+i),username:handles[i%10]+String(20+i)+'_'+String(seed).slice(-3),nickname,style:styles[i%10],avatar:pick(['🌊','🌿','🧭','🌸','🏔️','☀️']),
  createdAt:new Date(now-(200+rnd()*160)*86400000).toISOString(),preferences:{interests:styles[i%10].tags,pace:i%3===0?'relaxed':i%3===1?'balanced':'full'}}));
 const posts=[];const allocation=[...users.map((_,i)=>i),...users.map((_,i)=>i),...users.map((_,i)=>i),...Array.from({length:350},()=>Math.floor(rnd()*rnd()*50))];
 for(let i=0;i<500;i++){const u=users[allocation[i]],style=u.style;
  const preferred=routes.filter(r=>r.stops.some(p=>style.keywords.some(k=>p.name.includes(k))));const r=pick(preferred.length?preferred:routes),count=2+Math.floor(rnd()*Math.min(4,r.stops.length-1));
  const stops=r.stops.slice(0,count).map(({id,name,lat,lng,category,country,coord_system,mainlandCityVerified,source_url,license})=>({id,name,lat,lng,category,country,coord_system,mainlandCityVerified,source_url,license}));
  const age=1+Math.floor(rnd()*180),hour=pick([7,8,12,13,18,19,20,21,22]),base=new Date(now-age*86400000);base.setUTCHours(hour-8,Math.floor(rnd()*60),Math.floor(rnd()*60),0);
  const hasRoute=rnd()>.22,placeNames=stops.map(s=>s.name),intro=pick(openings[style.voice]);
  const title=pick([`${r.city.name}｜${placeNames[0]}之后，再走一小段`,`${style.name}：从${placeNames[0]}到${placeNames.at(-1)}`,`${r.city.name}周末，${pick(['不用赶路','看看街角','给自己放个小假','带着好奇心出门'])}`]);
  const body=[`${base.getUTCMonth()+1}月${base.getUTCDate()}日的散步灵感。${intro}`,`这一页记下的顺序：${placeNames.join(' → ')}。`,
   pick([`在${placeNames[0]}附近放慢脚步，给喜欢的部分多留一点时间。`,`如果只选一小段，我会从${placeNames[0]}开始，再看当天的状态。`,`最后一站留给${placeNames.at(-1)}，中间不用追求固定节奏。`]),
   style.voice==='list'?placeNames.map((n,j)=>`${j+1}. ${n}：想停就停，不需要每一处都打卡。`).join('\n'):
   style.voice==='photo'?'我会多看看建筑立面、树影和路口。拍摄时也记得给行人留出通道。':
   style.voice==='family'?'亲子路线最重要的是能随时休息，孩子累了就结束，不把路线当任务。':
   style.voice==='guide'?'把地点先存下来，出发前再核对官方开放与预约安排。':pick(['走过以后更喜欢这种有余地的安排。','如果天气或体力不合适，就少走一段。','这是我的路线灵感，你也可以换成自己喜欢的地点。']),
   `沿途我想留意${pick(['门牌上的字','建筑的轮廓','树下的长椅','街口的招牌','转角的色彩','桥边的风景','窗边的光影','路面的纹理'])}，${pick(['也留一段不看手机的时间','顺手记进随身的小本子','和同行的人分享发现','把印象深的地方画下来','不必为了照片反复折返','让当天的心情决定停多久'])}。`,
   pick(['你更喜欢慢逛，还是把路线排满？','下一次想换个时间再看看。','欢迎分享你在这座城市的小发现。'])].join('\n\n');
  const snapshot=hasRoute?{kind:'citywalk',cities:[r.city.name],days:[{city:r.city.name,stops}]}:{};
  posts.push({id:uuid(seed,'post:'+i),userId:u.id,title:title.slice(0,100),body,tags:style.tags,snapshot,createdAt:base.toISOString(),style:style.name});
 }
 return {batchId,seed,users,posts,now,algorithm:demoAlgorithm};
}
export async function seedDemo({query,transaction,seed=20261017,now=Date.now()}){
 const data=await generateDemo({seed,now}),{batchId,users,posts}=data;
 const old=(await query('SELECT manifest,status FROM recommendation_demo_batches WHERE id=$1',[batchId])).rows[0];
 if(old?.status==='ready')return {status:'already_exists',batchId,...old.manifest};
 const manifest={users:50,posts:500,fictional:true,seed,algorithm:demoAlgorithm,postStart:posts.map(p=>p.createdAt).sort()[0],postEnd:posts.map(p=>p.createdAt).sort().at(-1),userIds:users.map(u=>u.id)};
 await transaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(76102617)');
  if((await c.query("SELECT 1 FROM recommendation_demo_batches WHERE id=$1 AND status='ready'",[batchId])).rowCount)return;
  await c.query("DELETE FROM recommendation_demo_batches WHERE id=$1 AND status='removed'",[batchId]);
  await c.query('INSERT INTO recommendation_demo_batches(id,seed,algorithm,manifest) VALUES($1,$2,$3,$4)',[batchId,seed,demoAlgorithm,manifest]);
  // Invalid, non-reusable password hash + authentication denial for synthetic
  // accounts. No login credentials or admin roles are generated.
  for(const u of users)await c.query(`INSERT INTO users(id,username,password_hash,nickname,avatar,preferences,created_at,is_synthetic,synthetic_batch_id,analytics_excluded) VALUES($1,$2,$3,$4,$5,$6,$7,true,$8,true)`,[u.id,u.username,'!synthetic:'+randomBytes(32).toString('hex'),u.nickname,u.avatar,u.preferences,u.createdAt,batchId]);
  for(const p of posts){await c.query(`INSERT INTO posts(id,user_id,title,body,tags,snapshot,created_at,updated_at,is_synthetic,synthetic_batch_id) VALUES($1,$2,$3,$4,$5,$6,$7,$7,true,$8)`,[p.id,p.userId,p.title,p.body,p.tags,p.snapshot,p.createdAt,batchId]);await refreshItem(c,p.id);}
  const items=(await c.query('SELECT i.*,p.created_at,p.user_id FROM recommendation_items i JOIN posts p ON p.id=i.post_id WHERE p.synthetic_batch_id=$1',[batchId])).rows;
  const byId=new Map(items.map(p=>[p.post_id,p])),rnd=random(seed+40);
  for(const u of users){
   const pref={travel:{},content:{[u.style.format]:{long:{value:1,confidence:.9}}},authors:{}},uv=profileVector(pref,u.preferences);
   const seen=new Set();let events=0;
   for(let j=0;j<90;j++){
    const age=9+Math.floor(rnd()*145),at=now-age*86400000+rnd()*3600000;
    const eligible=posts.filter(p=>p.userId!==u.id&&!seen.has(p.id)&&new Date(p.createdAt).getTime()<at-86400000);if(!eligible.length)continue;
    const p=eligible[Math.floor(rnd()*eligible.length)],item=byId.get(p.id);seen.add(p.id);
    const parts=coarseFeatures({...item,id:p.id,features:item.features},uv,pref,{},at);
    const requestId=uuid(seed,'request:'+u.id+':'+j),impressionId=uuid(seed,'impression:'+u.id+':'+j),ts=new Date(at);
    await c.query(`INSERT INTO recommendation_requests(id,user_id,profile_version,user_vector,context,candidate_ids,trace,algorithm,created_at) VALUES($1,$2,0,$3,$4,$5,$6,$7,$8)`,[requestId,u.id,uv,{synthetic:true},[p.id],{items:[{id:p.id,revision:1,parts}]},algorithm,ts]);
    const visibleMs=2000+Math.floor(rnd()*58000);
    await c.query(`INSERT INTO social_impressions(id,user_id,post_id,context,visible_ms,created_at) VALUES($1,$2,$3,'feed',$4,$5)`,[impressionId,u.id,p.id,visibleMs,ts]);
    await c.query(`INSERT INTO recommendation_exposures(id,request_id,user_id,post_id,position,item_vector,visible_ms,created_at) VALUES($1,$2,$3,$4,0,$5,$6,$7)`,[impressionId,requestId,u.id,p.id,item.vector,visibleMs,ts]);
    await c.query('INSERT INTO browse_events(user_id,post_id,day,dwell_seconds,created_at) VALUES($1,$2,$3,$4,$5)',[u.id,p.id,ts.toISOString().slice(0,10),Math.floor(visibleMs/1000),ts]);
    const affinity=Math.max(0,cosine(uv,item.vector)),positive=rnd()<Math.min(.9,.07+affinity*.95);
    if(positive){const kind=rnd()<.45?'save':rnd()<.5?'recommend':'like';await c.query('INSERT INTO reactions(user_id,post_id,kind,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[u.id,p.id,kind,new Date(at+60000)]);
     // Trigger timestamps represent real writes. Synthetic historical actions
     // explicitly use the simulated time and remain tagged through their owner.
     await c.query('UPDATE recommendation_outcomes SET occurred_at=$4 WHERE user_id=$1 AND post_id=$2 AND kind=$3',[u.id,p.id,kind,new Date(at+60000)]);events++;
     if(rnd()<.15){await c.query('INSERT INTO comments(id,user_id,post_id,body,created_at) VALUES($1,$2,$3,$4,$5)',[uuid(seed,'comment:'+u.id+':'+j),u.id,p.id,['这个顺序很适合慢慢走。','先收好了，想找个周末试试看。','我更喜欢前半段，后面可以留到下次。'][j%3],new Date(at+120000)]);await c.query("UPDATE recommendation_outcomes SET occurred_at=$3 WHERE user_id=$1 AND post_id=$2 AND kind='comment'",[u.id,p.id,new Date(at+120000)]);}
     if(p.snapshot.days?.length&&rnd()<.1){
      const tripId=uuid(seed,'trip:'+u.id+':'+j),sessionId=uuid(seed,'session:'+u.id+':'+j),request={interests:u.preferences.interests,pace:u.preferences.pace};
      await c.query('INSERT INTO social_adoptions(user_id,post_id,created_at) VALUES($1,$2,$3)',[u.id,p.id,new Date(at+180000)]);
      await c.query("INSERT INTO trips(id,user_id,title,request,plan,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'completed',$6,$7)",[tripId,u.id,p.title,request,p.snapshot,new Date(at+240000),new Date(at+4*86400000)]);
      await c.query('INSERT INTO journey_sessions(id,user_id,request,trip_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',[sessionId,u.id,request,tripId,new Date(at+240000)]);
      await c.query('INSERT INTO recommendation_trip_sources(session_id,user_id,post_id,trip_id,created_at) VALUES($1,$2,$3,$4,$5)',[sessionId,u.id,p.id,tripId,new Date(at+240000)]);
      await c.query("INSERT INTO recommendation_outcomes(user_id,post_id,kind,active,occurred_at) VALUES($1,$2,'adopt',true,$3)",[u.id,p.id,new Date(at+240000)]);
      const rating=rnd()<.8?4:2;
      await c.query("INSERT INTO recommendation_trip_feedback(trip_id,user_id,rating,aspects,experience,created_at,updated_at) VALUES($1,$2,$3,$4,'trip',$5,$5)",[tripId,u.id,rating,{places:rating,pace:rating===4?'good':'too_busy'},new Date(at+4*86400000)]);
      await c.query("UPDATE recommendation_outcomes SET occurred_at=$3 WHERE user_id=$1 AND post_id=$2 AND kind='adopt_intent'",[u.id,p.id,new Date(at+180000)]);
      await c.query("UPDATE recommendation_outcomes SET occurred_at=$3 WHERE user_id=$1 AND post_id=$2 AND kind IN ('satisfied','dissatisfied')",[u.id,p.id,new Date(at+4*86400000)]);
     }
    }else if(rnd()<.12){await c.query("INSERT INTO social_feedback(user_id,post_id,kind,created_at) VALUES($1,$2,'not_interested',$3) ON CONFLICT DO NOTHING",[u.id,p.id,new Date(at+60000)]);await c.query("UPDATE recommendation_outcomes SET occurred_at=$3 WHERE user_id=$1 AND post_id=$2 AND kind='not_interested'",[u.id,p.id,new Date(at+60000)]);}
   }
   const authors=users.filter(v=>v.id!==u.id&&v.style.name===u.style.name).slice(0,2);
   for(const author of authors){await c.query('INSERT INTO user_follows(user_id,author_id,created_at) VALUES($1,$2,$3)',[u.id,author.id,new Date(now-20*86400000)]);await c.query("UPDATE recommendation_outcomes SET occurred_at=$3 WHERE user_id=$1 AND author_id=$2 AND kind='follow'",[u.id,author.id,new Date(now-20*86400000)]);}
   await rebuildStyle(c,u.id);await buildProfile(c,u.id);await c.query('DELETE FROM style_dirty_users WHERE user_id=$1',[u.id]);
  }
 });
 return {status:'created',batchId,...manifest};
}
export async function removeDemo({transaction,batchId}){
 return transaction(async c=>{
  const b=(await c.query('SELECT * FROM recommendation_demo_batches WHERE id=$1 FOR UPDATE',[batchId])).rows[0];if(!b)throw Error('Unknown demo batch');
  if(b.status==='removed')return {status:'already_removed',batchId};
  const invalid=(await c.query("SELECT id FROM users WHERE synthetic_batch_id=$1 AND (NOT is_synthetic OR role<>'user')",[batchId])).rows;
  if(invalid.length)throw Error('Batch ownership changed; refusing deletion');
  const result=await c.query('DELETE FROM users WHERE synthetic_batch_id=$1 AND is_synthetic',[batchId]);
  await c.query("DELETE FROM recommendation_models WHERE scope='synthetic' AND metrics->'syntheticBatchIds' ? $1",[batchId]);
  await c.query("UPDATE recommendation_demo_batches SET status='removed' WHERE id=$1",[batchId]);return {status:'removed',batchId,users:result.rowCount};
 });
}
