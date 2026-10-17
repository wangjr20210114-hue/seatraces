import {icon} from './ui-icons.js';
import {esc,routeCover,mapCover,trackVisible} from './social-ui.js';
import {routeMap} from './route-map.js';
export async function mountSocialPost({route,content,setTitle,api,navigate,isCurrent,toast,onAdopt}){
 let dead=false,tracker,frame,scene;
 const live=()=>!dead&&isCurrent(),$=s=>content.querySelector(s);
 function paint(){if(live()&&scene)frame?.contentWindow?.postMessage(scene,location.origin);}
 function ready(e){if(e.origin===location.origin&&e.source===frame?.contentWindow&&e.data?.type==='seatraces-map-ready')paint();}
 window.addEventListener('message',ready);
 const cleanup=()=>{dead=true;tracker?.dispose();window.removeEventListener('message',ready);};
 setTitle('旅行分享');content.innerHTML='<p role="status">正在打开…</p>';
 try{
  const p=await api('/api/social/posts/'+encodeURIComponent(route.id));if(!live())return cleanup;
  const hasRoute=!!p.snapshot?.days?.length;
  content.innerHTML=`<article class="social-post" data-post="${esc(p.id)}"><header><span class="post-avatar">${esc(p.avatar)}</span><b>${esc(p.nickname)}</b>${p.isOwn?`<button class="social-follow" data-edit>${icon('edit')}编辑</button>`:`<button class="social-follow" data-follow aria-pressed="${p.following}">${icon(p.following?'check':'plus')}${p.following?'已关注':'关注'}</button>`}</header><div class="post-gallery">${p.media.length?p.media.map((m,i)=>`<img src="/api/social/media/${esc(m.id)}" alt="分享照片 ${i+1}" loading="${i?'lazy':'eager'}">`).join(''):(hasRoute?mapCover('post',p.id,p.title,p.revision):routeCover(p.snapshot,p.title))}</div><h1>${esc(p.title)}</h1><div class="post-body">${p.body.split(/\n\s*\n/).filter(Boolean).map(text=>`<p>${esc(text)}</p>`).join('')}</div><div class="post-tags">${p.tags.map(t=>`<span># ${esc(t)}</span>`).join(' ')}</div>${hasRoute?`<details class="post-route"><summary>这篇分享的路线 ▾</summary><div class="classic-map"><iframe title="分享的路线地图" data-src="/amap-view.html?mode=home"></iframe></div>${p.snapshot.days.map((d,i)=>`<p><b>Day ${i+1} · ${esc(d.city)}</b><br>${(d.stops||[]).map(s=>esc(s.name)).join(' → ')}</p>`).join('')}<button class="primary" data-adopt>用这条路线规划 ↗</button></details>`:''}<footer class="post-actions">${[['like','点赞'],['save','收藏'],['recommend','推荐']].map(([k,label])=>`<button class="social-action ${k}" data-reaction="${k}" aria-label="${p.reactions.includes(k)?'取消':''}${label}" aria-pressed="${p.reactions.includes(k)}">${icon(k)}<span>${label}</span></button>`).join('')}<button class="social-action" data-share>${icon('share')}<span>分享</span></button></footer>${!p.isOwn?`<button class="social-subtle" data-uninterested>${p.not_interested?'恢复此类推荐':'不感兴趣'}</button>`:''}<section class="post-comments"><h2>一起聊聊</h2><form><input maxlength="500" required aria-label="评论内容" placeholder="写下你的想法"><button class="primary">发送</button></form><div class="comment-list"></div></section></article><p role="status" aria-live="polite"></p>`;
  tracker=trackVisible(content,{api,context:'detail'});const fail=e=>{if(live())$('[role=status]').textContent=e.message;};
  if(hasRoute){frame=$('iframe');const {stops,connections}=routeMap(p.snapshot);
   scene={type:'seatraces-route',kind:'citywalk',contextKey:'post-'+p.id,lockView:true,view:'day',fitKey:'post-'+p.id,viewPadding:[55,35,35,35],stops,connections,cities:[],cityConnections:[],segments:[]};
   $('.post-route').ontoggle=e=>{if(e.currentTarget.open){if(!frame.hasAttribute('src'))frame.src=frame.dataset.src;requestAnimationFrame(paint);}};
   $('[data-adopt]').onclick=async e=>{e.currentTarget.disabled=true;try{await onAdopt(p);}catch(e){fail(e);}finally{if(live())$('[data-adopt]').disabled=false;}};
  }
  if($('[data-edit]'))$('[data-edit]').onclick=async()=>{try{const d=await api('/api/social/drafts',{id:crypto.randomUUID(),postId:p.id});if(live())navigate('/compose/'+d.id);}catch(e){fail(e);}};
  if($('[data-follow]'))$('[data-follow]').onclick=async e=>{const b=e.currentTarget;b.disabled=true;try{const r=await api('/api/social/authors/'+p.user_id+'/follow',{active:!p.following},'PUT');p.following=r.following;b.innerHTML=icon(p.following?'check':'plus')+(p.following?'已关注':'关注');b.setAttribute('aria-pressed',String(p.following));}catch(e){fail(e);}finally{b.disabled=false;}};
  content.querySelectorAll('[data-reaction]').forEach(b=>b.onclick=async()=>{b.disabled=true;const kind=b.dataset.reaction,active=b.getAttribute('aria-pressed')!=='true';try{await api('/api/posts/'+p.id+'/reactions',{kind,active});b.setAttribute('aria-pressed',String(active));b.setAttribute('aria-label',(active?'取消':'')+({like:'点赞',save:'收藏',recommend:'推荐'}[kind]));}catch(e){fail(e);}finally{b.disabled=false;}});
  if($('[data-uninterested]'))$('[data-uninterested]').onclick=async e=>{const b=e.currentTarget;b.disabled=true;try{await api('/api/social/posts/'+p.id+'/feedback',{notInterested:!p.not_interested},'PUT');p.not_interested=!p.not_interested;b.textContent=p.not_interested?'恢复此类推荐':'不感兴趣';toast(p.not_interested?'已减少此类推荐':'已恢复推荐');}catch(e){fail(e);}finally{b.disabled=false;}};
  $('[data-share]').onclick=async()=>{const url=location.origin+'/#/post/'+p.id;try{if(navigator.share)await navigator.share({title:p.title,url});else{await navigator.clipboard.writeText(url);toast('链接已复制');}}catch(e){if(e.name!=='AbortError')fail(Error('复制未成功，可从地址栏分享链接'));}};
  const comments=async()=>{const rows=await api('/api/posts/'+p.id+'/comments');if(live())$('.comment-list').innerHTML=rows.map(c=>`<article><b>${esc(c.avatar)} ${esc(c.nickname)}</b><p>${esc(c.body)}</p></article>`).join('')||'<p>聊聊这条路线吧</p>';};
  $('.post-comments form').onsubmit=async e=>{e.preventDefault();const input=e.currentTarget.querySelector('input'),button=e.currentTarget.querySelector('button');button.disabled=true;try{await api('/api/posts/'+p.id+'/comments',{body:input.value});input.value='';await comments();}catch(e){fail(e);}finally{button.disabled=false;}};
  await comments();
 }catch(e){if(live())content.textContent=e.message;}
 return cleanup;
}
