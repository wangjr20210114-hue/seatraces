const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function renderInbox({route,content,setTitle,api,navigate,isCurrent}) {
  setTitle(route.page==='settings'?'设置':'消息');content.innerHTML='<p class="page-status">正在打开…</p>';
  try{
    if(route.page==='social-messages'){
      setTitle('互动消息');content.innerHTML='<div class="social-notices"></div><p role="status"></p><button class="loadmore" hidden>更多消息 ↓</button>';let offset=0;
      const list=content.querySelector('.social-notices'),more=content.querySelector('.loadmore'),status=content.querySelector('[role=status]');
      const load=async()=>{more.disabled=true;try{const r=await api('/api/social/notifications?limit=20&offset='+offset);if(!isCurrent())return;list.insertAdjacentHTML('beforeend',r.items.map(n=>`<button class="social-notice ${n.read_at?'':'unread'}" data-notice="${esc(n.id)}" data-post="${esc(n.post_id||'')}"><b>${esc(n.avatar)} ${esc(n.nickname)}</b><p>${{like:'赞了你的分享',recommend:'推荐了你的分享',comment:'评论了你的分享',follow:'关注了你'}[n.kind]}</p>${esc(n.title||'')}</button>`).join(''));offset+=r.items.length;more.hidden=!r.hasMore;status.textContent=offset?'':'还没有互动消息';}catch(e){status.textContent=e.message;}finally{more.disabled=false;}};
      list.onclick=async e=>{const b=e.target.closest('[data-notice]');if(!b)return;try{await api('/api/social/notifications/'+b.dataset.notice+'/read',{},'PUT');b.classList.remove('unread');if(b.dataset.post)navigate('/post/'+b.dataset.post);}catch(e){status.textContent=e.message;}};more.onclick=load;await load();return;
    }
    if(route.page==='settings'){
      const r=await api('/api/me/messages?limit=1');if(!isCurrent())return;
      content.innerHTML=`<div class="settings-menu"><button id="inbox-open" class="profile-card"><span class="tile-icon mint">✉</span><b>消息</b><span class="inbox-count">${r.unread||''}</span><span>→</span></button><button id="settings-account" class="profile-card"><span class="tile-icon peach">☺</span><b>我的账号</b><span>→</span></button></div>`;
      content.querySelector('.settings-menu').insertAdjacentHTML('beforeend',[['security','◇','账号安全'],['style','✦','旅行偏好'],['help','?','帮助与关于']].map(([path,icon,title])=>`<a class="profile-card" href="#/${path}"><span class="tile-icon yellow">${icon}</span><b>${title}</b><span>→</span></a>`).join(''));
      content.querySelector('#inbox-open').onclick=()=>navigate('/messages');content.querySelector('#settings-account').onclick=()=>navigate('/account');return;
    }
    if(route.id){
      const r=await api('/api/me/messages/'+encodeURIComponent(route.id));if(!isCurrent())return;
      content.innerHTML=`<article class="inbox-letter"><h2>${esc(r.title)}</h2><time>${new Date(r.created_at).toLocaleDateString('zh-CN')}</time><div class="inbox-body">${esc(r.body)}</div></article>`;
      await api('/api/me/messages/'+encodeURIComponent(route.id)+'/read',{});return;
    }
    content.innerHTML='<a class="social-message-link" href="#/social-messages">♡ 互动消息 →</a><div class="inbox-list"></div><p class="page-status" role="status"></p><button class="loadmore" hidden>更多消息 ↓</button>';
    const list=content.querySelector('.inbox-list'),status=content.querySelector('.page-status'),more=content.querySelector('.loadmore');let offset=0;
    const load=async()=>{more.disabled=true;status.textContent='正在整理消息…';try{const r=await api('/api/me/messages?'+new URLSearchParams({limit:20,offset}));if(!isCurrent())return;list.insertAdjacentHTML('beforeend',r.items.map(m=>`<button class="inbox-item ${m.read_at?'':'unread'}" data-message="${m.id}"><span class="inbox-dot"></span><b>${esc(m.title)}</b><time>${new Date(m.created_at).toLocaleDateString('zh-CN')}</time><span>→</span></button>`).join(''));offset+=r.items.length;more.hidden=!r.hasMore;status.textContent=offset?'':'还没有消息';}catch(e){if(isCurrent())status.textContent=e.message;}finally{more.disabled=false;}};
    list.onclick=e=>{const b=e.target.closest('[data-message]');if(b)navigate('/messages/'+b.dataset.message);};more.onclick=()=>void load();await load();
  }catch(e){if(isCurrent())content.textContent=e.message;}
}
