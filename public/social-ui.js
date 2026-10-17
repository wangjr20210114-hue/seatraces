import {icon} from './ui-icons.js';
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function routeCover(snapshot={},title='下一程，去哪里？'){
 const points=(snapshot.days||[]).flatMap(d=>d.stops||[]).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng)).slice(0,50);
 if(points.length<2)return `<div class="social-cover text-cover"><span>✦</span><b>${esc(title)}</b><i>≈</i></div>`;
 const xs=points.map(p=>p.lng),ys=points.map(p=>p.lat),w=Math.min(...xs),s=Math.min(...ys),dx=Math.max(...xs)-w,dy=Math.max(...ys)-s;
 const scale=Math.min(250/Math.max(dx,.00001),150/Math.max(dy,.00001));
 const xy=points.map(p=>[35+(p.lng-w)*scale+(250-dx*scale)/2,35+(Math.max(...ys)-p.lat)*scale+(150-dy*scale)/2]);
 const path=xy.slice(1).map(([x,y],i)=>{const [a,b]=xy[i];return `M${a},${b} Q${(a+x)/2-(y-b)*.12},${(b+y)/2+(x-a)*.12} ${x},${y}`;}).join(' ');
 return `<div class="social-cover route-cover"><svg viewBox="0 0 320 220" role="img" aria-label="路线示意"><path d="${path}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>${xy.map(([x,y],i)=>`<circle cx="${x}" cy="${y}" r="${i===0?7:4}" fill="${i===0?'#faab86':'#20baa9'}" stroke="currentColor"/>`).join('')}</svg><span>${esc((snapshot.cities||[]).join(' · '))}</span></div>`;
}
export function mapCover(kind,id,title='',revision=''){
 return `<div class="social-cover map-cover"><span>地图加载中</span><img loading="lazy" src="/api/social/route-covers/${esc(kind)}/${esc(id)}?v=${esc(revision)}" alt="${esc(title)} · 路线地图"></div>`;
}
if(typeof document!=='undefined'){
 document.addEventListener('load',e=>{if(e.target.matches?.('.map-cover img'))e.target.parentElement.classList.add('map-loaded');},true);
 document.addEventListener('error',e=>{if(e.target.matches?.('.map-cover img')){e.target.hidden=true;e.target.parentElement.querySelector('span').textContent='地图暂未加载';}},true);
}
export function socialCard(p){
 const cover=p.cover_id?`<img class="social-cover" loading="lazy" src="/api/social/media/${esc(p.cover_id)}" alt="${esc(p.title)}">`:p.day_count||p.preview?.length?mapCover('post',p.id,p.title,p.revision):routeCover({},p.title);
 const city=Array.isArray(p.cities)?p.cities.slice(0,2).filter(s=>typeof s==='string').join(' · '):'';
 return `<article class="social-card" data-post="${esc(p.id)}" data-recommendation-request="${esc(p.requestId||'')}"><a href="#/post/${esc(p.id)}"><div class="social-card-media">${cover}${city?`<span class="social-location">${icon('pin')}${esc(city)}</span>`:''}</div><div class="social-card-copy"><h2>${esc(p.title)}</h2>${p.is_synthetic?'<span class="synthetic-label">模拟内容</span>':''}${p.excerpt?`<p class="social-excerpt">${esc(p.excerpt)}</p>`:''}</div></a><footer><span class="social-author"><i>${esc(p.avatar||'🌊')}</i><span>${esc(p.nickname||'旅行者')}</span></span><button class="social-like" data-like="${esc(p.id)}" aria-label="${p.liked?'取消点赞':'点赞'}" aria-pressed="${!!p.liked}">${icon('like')}<span>${p.likes||0}</span></button></footer></article>`;
}
export function bindCardActions(container,{api,toast=()=>{}}){
 const click=async e=>{const b=e.target.closest('[data-like]');if(!b)return;const active=b.getAttribute('aria-pressed')!=='true',n=Number(b.querySelector('span')?.textContent||0);b.disabled=true;
  try{await api('/api/posts/'+b.dataset.like+'/reactions',{kind:'like',active});b.setAttribute('aria-pressed',String(active));b.setAttribute('aria-label',active?'取消点赞':'点赞');b.innerHTML=`${icon('like')}<span>${Math.max(0,n+(active?1:-1))}</span>`;}catch(e){toast(e.message);}finally{b.disabled=false;}};
 container.addEventListener('click',click);return()=>container.removeEventListener('click',click);
}
export function trackVisible(container,{api,context='feed'}){
 const records=new Map();let stopped=false;
 function tick(){const now=performance.now();for(const r of records.values()){if(r.visible&&!document.hidden)r.ms=Math.min(120000,r.ms+now-r.last);r.last=now;}}
 async function flush(){tick();for(const r of records.values()){if(r.ms<1000||r.pending||r.ms<=r.sent)continue;r.pending=true;
  try{if(!r.issued){await api('/api/social/posts/'+r.post+'/impressions',{id:r.id,context,...(r.requestId?{requestId:r.requestId}:{})});r.issued=true;r.ms=0;r.last=performance.now();continue;}
   const ms=Math.floor(r.ms);await api('/api/social/impressions/'+r.id,{visibleMs:ms},'PUT');r.sent=ms;
  }catch{}finally{r.pending=false;}}}
 const observer=new IntersectionObserver(entries=>{tick();for(const e of entries){const post=e.target.dataset.post;if(!records.has(post))records.set(post,{id:crypto.randomUUID(),post,requestId:e.target.dataset.recommendationRequest,visible:false,last:performance.now(),ms:0,sent:0});
  const visibleHeight=e.intersectionRect.height,required=Math.min(e.boundingClientRect.height,e.rootBounds?.height||innerHeight)*.6;
  records.get(post).visible=e.isIntersecting&&visibleHeight>=required;
 }},{threshold:Array.from({length:21},(_,i)=>i/20)});
 function observe(){if(!stopped)container.querySelectorAll('[data-post]').forEach(el=>observer.observe(el));}
 const timer=setInterval(flush,5000),visibility=()=>{tick();void flush();};document.addEventListener('visibilitychange',visibility);observe();
 return {observe,dispose(){stopped=true;clearInterval(timer);observer.disconnect();document.removeEventListener('visibilitychange',visibility);void flush();}};
}
