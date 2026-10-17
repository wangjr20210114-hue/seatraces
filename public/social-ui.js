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
export function socialCard(p){
 const cover=p.cover_id?`<img class="social-cover" loading="lazy" src="/api/social/media/${esc(p.cover_id)}" alt="${esc(p.title)}">`:routeCover({cities:p.cities||[],days:p.preview?[{stops:p.preview}]:[]},p.title);
 return `<article class="social-card" data-post="${esc(p.id)}"><a href="#/post/${esc(p.id)}">${cover}<h2>${esc(p.title)}</h2></a><footer><span>${esc(p.avatar||'🌊')} ${esc(p.nickname||'旅行者')}</span><button data-like="${esc(p.id)}" aria-label="${p.liked?'取消点赞':'点赞'}" aria-pressed="${!!p.liked}">${p.liked?'♥':'♡'} <span>${p.likes||0}</span></button></footer></article>`;
}
export function bindCardActions(container,{api,toast=()=>{}}){
 const click=async e=>{const b=e.target.closest('[data-like]');if(!b)return;const active=b.getAttribute('aria-pressed')!=='true',n=Number(b.querySelector('span')?.textContent||0);b.disabled=true;
  try{await api('/api/posts/'+b.dataset.like+'/reactions',{kind:'like',active});b.setAttribute('aria-pressed',String(active));b.setAttribute('aria-label',active?'取消点赞':'点赞');b.innerHTML=`${active?'♥':'♡'} <span>${Math.max(0,n+(active?1:-1))}</span>`;}catch(e){toast(e.message);}finally{b.disabled=false;}};
 container.addEventListener('click',click);return()=>container.removeEventListener('click',click);
}
export function trackVisible(container,{api,context='feed'}){
 const records=new Map();let stopped=false;
 function tick(){const now=performance.now();for(const r of records.values()){if(r.visible&&!document.hidden)r.ms=Math.min(120000,r.ms+now-r.last);r.last=now;}}
 async function flush(){tick();for(const r of records.values()){if(r.ms<1000||r.pending||r.ms<=r.sent)continue;r.pending=true;
  try{if(!r.issued){await api('/api/social/posts/'+r.post+'/impressions',{id:r.id,context});r.issued=true;r.ms=0;r.last=performance.now();continue;}
   const ms=Math.floor(r.ms);await api('/api/social/impressions/'+r.id,{visibleMs:ms},'PUT');r.sent=ms;
  }catch{}finally{r.pending=false;}}}
 const observer=new IntersectionObserver(entries=>{tick();for(const e of entries){const post=e.target.dataset.post;if(!records.has(post))records.set(post,{id:crypto.randomUUID(),post,visible:false,last:performance.now(),ms:0,sent:0});
  const visibleHeight=e.intersectionRect.height,required=Math.min(e.boundingClientRect.height,e.rootBounds?.height||innerHeight)*.6;
  records.get(post).visible=e.isIntersecting&&visibleHeight>=required;
 }},{threshold:Array.from({length:21},(_,i)=>i/20)});
 function observe(){if(!stopped)container.querySelectorAll('[data-post]').forEach(el=>observer.observe(el));}
 const timer=setInterval(flush,5000),visibility=()=>{tick();void flush();};document.addEventListener('visibilitychange',visibility);observe();
 return {observe,dispose(){stopped=true;clearInterval(timer);observer.disconnect();document.removeEventListener('visibilitychange',visibility);void flush();}};
}
