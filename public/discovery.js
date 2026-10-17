import {esc,socialCard,bindCardActions,trackVisible} from './social-ui.js';
export const discoveryCard=socialCard;
export async function publishRoute({button,kind,id,api,navigate,toast}){
 if(button.disabled)return;button.disabled=true;const label=button.textContent;button.textContent='正在准备…';
 try{const d=await api('/api/social/drafts',{id:crypto.randomUUID(),source:{kind,id}});navigate('/compose/'+d.id+'?write=1');}
 catch(e){toast(e.message);}finally{button.disabled=false;button.textContent=label;}
}
export function mountDiscovery({content,api,navigate,toast}){
 let dead=false,revision=0,scope='recommended',cursor=null,busy=false,q='';
 content.innerHTML=`<div class="social-toolbar"><form role="search"><input name="search" maxlength="60" aria-label="搜索旅行灵感" placeholder="寻找旅行灵感"><button aria-label="搜索">⌕</button></form><button class="primary social-write">＋ 发帖</button></div><div class="social-tabs"><button data-scope="recommended" aria-pressed="true">推荐</button><button data-scope="following" aria-pressed="false">关注</button></div><div class="social-feed"></div><p role="status"></p><button class="loadmore" hidden>更多灵感 ↓</button>`;
 const feed=content.querySelector('.social-feed'),status=content.querySelector('[role=status]'),more=content.querySelector('.loadmore');
 const unbind=bindCardActions(feed,{api,toast}),tracker=trackVisible(feed,{api});
 async function load(append=false){if(append&&busy)return;const rev=++revision;busy=true;more.disabled=true;status.textContent='正在找灵感…';
  try{const params=new URLSearchParams({scope,q,limit:12,...(append&&cursor?{cursor}:{})});const r=await api('/api/social/feed?'+params);
   if(dead||revision!==rev)return;if(!append)feed.replaceChildren();feed.insertAdjacentHTML('beforeend',r.items.map(socialCard).join(''));tracker.observe();cursor=r.nextCursor;more.hidden=!cursor;status.textContent=feed.childElementCount?'':scope==='following'?'关注喜欢的作者，下一程有新灵感':'还没有帖子，分享第一程吧';
  }catch(e){if(!dead&&revision===rev){status.textContent=e.message;more.hidden=false;more.textContent='重新加载';cursor=null;}}
  finally{if(!dead&&revision===rev){busy=false;more.disabled=false;}}
 }
 content.querySelector('.social-write').onclick=()=>navigate('/compose/new');
 content.querySelector('form').onsubmit=e=>{e.preventDefault();q=new FormData(e.currentTarget).get('search').trim();void load();};
 content.querySelectorAll('[data-scope]').forEach(b=>b.onclick=()=>{if(scope===b.dataset.scope)return;scope=b.dataset.scope;content.querySelectorAll('[data-scope]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));void load();});
 more.onclick=()=>load(!!cursor);void load();return()=>{dead=true;revision++;tracker.dispose();unbind();};
}
export function mountPersonalPosts({content,api,navigate,toast}){
 let dead=false,tab='posts',draft=false,revision=0,cursor=null,offset=0;
 content.innerHTML='<div class="social-tabs personal-tabs"><button data-tab="posts" aria-pressed="true">我的帖子</button><button data-tab="favorites">收藏</button><button data-tab="browsing">浏览</button></div><div class="social-subtabs"><button data-draft="0" aria-pressed="true">已发布</button><button data-draft="1">草稿</button><a href="#/compose/new">＋ 发帖</a></div><div class="social-feed"></div><p role="status"></p><button class="loadmore" hidden>更多 ↓</button>';
 const feed=content.querySelector('.social-feed'),status=content.querySelector('[role=status]'),more=content.querySelector('.loadmore');const unbind=bindCardActions(feed,{api,toast});
 async function load(append=false){const rev=++revision;more.disabled=true;if(!append){cursor=null;offset=0;feed.replaceChildren();}status.textContent='正在整理…';
  try{const url=tab==='posts'?draft?'/api/social/drafts?limit=12&offset='+offset:'/api/social/feed?scope=mine&limit=12'+(cursor?'&cursor='+encodeURIComponent(cursor):''):`/api/me/library/${tab}?limit=12&offset=${offset}`;const r=await api(url);if(dead||revision!==rev)return;
   if(tab==='posts'&&!draft)feed.insertAdjacentHTML('beforeend',r.items.map(socialCard).join(''));
   else feed.insertAdjacentHTML('beforeend',r.items.map(p=>`<article class="social-card simple-card"><a href="#/${draft&&tab==='posts'?'compose':'post'}/${esc(p.id)}"><span>${draft&&tab==='posts'?'✎':'✦'}</span><h2>${esc(p.title||'未命名草稿')}</h2></a>${draft&&tab==='posts'?`<button class="social-subtle" data-delete-draft="${esc(p.id)}" data-version="${p.version}">删除草稿</button>`:''}</article>`).join(''));
   offset+=r.items.length;cursor=r.nextCursor;more.hidden=!(cursor||r.hasMore);status.textContent=feed.childElementCount?'':'这里还空着，去发现逛逛吧';
  }catch(e){if(!dead&&revision===rev){status.textContent=e.message;more.hidden=false;}}
  finally{if(!dead&&revision===rev)more.disabled=false;}
 }
 const clear=document.createElement('button');clear.className='social-subtle';clear.hidden=true;clear.textContent='清空浏览记录';content.querySelector('.social-tabs').after(clear);
 clear.onclick=async()=>{if(!clear.dataset.confirm){clear.dataset.confirm='1';clear.textContent='确认清空自己的浏览记录';return;}clear.disabled=true;try{await api('/api/me/history',undefined,'DELETE');if(!dead){delete clear.dataset.confirm;clear.textContent='清空浏览记录';await load();}}catch(e){toast(e.message);}finally{clear.disabled=false;}};
 feed.addEventListener('click',async e=>{const b=e.target.closest('[data-delete-draft]');if(!b)return;if(!b.dataset.confirm){b.dataset.confirm='1';b.textContent='确认删除草稿';return;}b.disabled=true;try{await api('/api/social/drafts/'+b.dataset.deleteDraft,{version:Number(b.dataset.version)},'DELETE');if(!dead)await load();}catch(e){toast(e.message);}finally{b.disabled=false;}});
 content.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;clear.hidden=tab!=='browsing';delete clear.dataset.confirm;clear.textContent='清空浏览记录';content.querySelectorAll('[data-tab]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));content.querySelector('.social-subtabs').hidden=tab!=='posts';void load();});
 content.querySelectorAll('[data-draft]').forEach(b=>b.onclick=()=>{draft=b.dataset.draft==='1';content.querySelectorAll('[data-draft]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));void load();});
 more.onclick=()=>load(true);void load();return()=>{dead=true;revision++;unbind();};
}
