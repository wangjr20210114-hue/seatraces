import {showMessageEffects} from './admin-message-effects.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function mountAdminMessages({content,status,api,isCurrent}) {
  let viewRevision=0,offset=0;
  const valid=n=>isCurrent()&&n===viewRevision;
  const failure=e=>{if(isCurrent())status.textContent=e.message;};
  async function preview(id){
    const n=++viewRevision;status.textContent='正在预览…';
    try{const v=await api('/api/admin/messages/'+id+'/preview');if(!valid(n))return;
      const sent=v.status==='sent',draft=v.status==='draft';
      content.innerHTML=`<article class="admin-card"><h3>${esc(v.title)}</h3><p>${sent?'已发送':draft?'待发送':'已取消'} · ${v.audience==='all'?'全体有效用户':`指定用户 ${v.recipients.map(u=>esc(u.username)).join('、')}`} · ${sent?v.recipient_count:v.eligibleRecipients} 位收件人</p><pre>${esc(v.body)}</pre><div class="actions">${draft?'<button id="send-message" class="primary">确认发送站内信</button><button id="edit-message">修改草稿</button><button id="cancel-message">取消草稿</button>':''}<button id="message-back">返回列表</button></div></article>`;
      status.textContent='';content.querySelector('#message-back').onclick=()=>void list();
      if(draft){
        const send=content.querySelector('#send-message');send.disabled=v.eligibleRecipients===0;
        send.onclick=async()=>{send.disabled=true;try{await api('/api/admin/messages/'+id+'/send',{version:v.version,recipientCount:v.eligibleRecipients,confirmation:'send'});if(valid(n))await preview(id);}catch(e){failure(e);if(valid(n))send.disabled=false;}};
        content.querySelector('#edit-message').onclick=()=>void compose(v);
        content.querySelector('#cancel-message').onclick=async()=>{try{await api('/api/admin/messages/'+id+'/cancel',{});if(valid(n))await list();}catch(e){failure(e);}};
      }
    }catch(e){failure(e);}
  }
  async function compose(existing){
    const n=++viewRevision,selected=new Map((existing?.recipients||[]).map(u=>[u.id,u])),id=existing?.id||crypto.randomUUID();
    content.innerHTML=`<form id="message-form" class="admin-card form-stack"><label>标题<input name="title" required maxlength="80" value="${esc(existing?.title||'')}"></label><label>正文<textarea name="body" required maxlength="4000">${esc(existing?.body||'')}</textarea></label><label>收件范围<select name="audience"><option value="selected">指定用户</option><option value="all">全体有效用户</option></select></label><section id="recipient-picker"><div class="filters"><label>查找收件人<input id="recipient-query" maxlength="80" placeholder="账号 / 昵称"></label><button type="button" id="recipient-search">查找</button></div><div class="filters"><label>按分群选取<select id="audience-segment"><option value="new">近7天注册</option><option value="active">近7天活跃</option><option value="inactive">近30天无已记录活动</option><option value="planners">已有行程</option><option value="walkers">已有CityWalk</option></select></label><button type="button" id="pick-segment">替换为该分群</button></div><p id="recipient-count"></p><div id="recipient-list"></div></section><div class="actions"><button class="primary">保存并预览</button><button type="button" id="compose-back">返回</button></div></form>`;
    const form=content.querySelector('#message-form'),picker=content.querySelector('#recipient-picker'),scope=form.elements.audience;
    scope.value=existing?.audience||'selected';picker.hidden=scope.value==='all';scope.onchange=()=>{picker.hidden=scope.value==='all';};
    const count=()=>{content.querySelector('#recipient-count').textContent=`已选 ${selected.size} 位用户`;};
    let searching=0;
    const search=async()=>{const seq=++searching;try{const r=await api('/api/admin/users?'+new URLSearchParams({q:content.querySelector('#recipient-query').value,limit:50}));if(!valid(n)||seq!==searching)return;
      content.querySelector('#recipient-list').innerHTML=r.items.filter(u=>!u.disabled_at&&!(u.role==='admin'&&/^demo_[a-f0-9]{8}$/.test(u.username))).map(u=>`<label class="recipient-choice"><input type="checkbox" value="${u.id}" ${selected.has(u.id)?'checked':''}> ${esc(u.username)} · ${esc(u.nickname)}</label>`).join('')||'<p>没有匹配用户</p>';
      content.querySelectorAll('#recipient-list input').forEach(b=>b.onchange=()=>{if(b.checked)selected.set(b.value,r.items.find(u=>u.id===b.value));else selected.delete(b.value);count();});
    }catch(e){failure(e);}};
    content.querySelector('#pick-segment').onclick=async()=>{const b=content.querySelector('#pick-segment');b.disabled=true;try{const v=await api('/api/admin/messages/audience?segment='+content.querySelector('#audience-segment').value);if(!valid(n))return;selected.clear();v.items.forEach(u=>selected.set(u.id,u));count();await search();status.textContent=v.label+' · 已选 '+v.items.length+' 人，保存草稿后预览确认';}catch(e){failure(e);}finally{b.disabled=false;}};
    content.querySelector('#recipient-search').onclick=()=>void search();content.querySelector('#compose-back').onclick=()=>void list();count();void search();
    form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button.primary');button.disabled=true;status.textContent='正在保存…';try{
      const fields=new FormData(form),b={id,title:fields.get('title'),body:fields.get('body'),audience:scope.value,recipientIds:scope.value==='all'?[]:[...selected.keys()]};
      if(existing)b.version=existing.version;
      await api('/api/admin/messages'+(existing?'/'+id:''),b,existing?'PUT':'POST');if(valid(n))await preview(id);
    }catch(e){failure(e);if(valid(n))button.disabled=false;}};
  }
  async function list(){
    const n=++viewRevision;status.textContent='正在加载消息…';
    try{const r=await api('/api/admin/messages?'+new URLSearchParams({limit:30,offset}));if(!valid(n))return;
      content.innerHTML=`<div class="actions"><button class="primary" id="new-message">新建站内信</button></div><div class="table-wrap"><table><thead><tr><th>标题</th><th>状态</th><th>收件 / 已读</th><th>操作</th></tr></thead><tbody>${r.items.map(v=>`<tr><td>${esc(v.title)}</td><td>${{draft:'草稿',sent:'已发送',cancelled:'已取消'}[v.status]}</td><td>${v.recipient_count} / ${v.read_count}</td><td><button data-campaign="${v.id}">查看</button> <button data-effects="${v.id}">投递效果</button></td></tr>`).join('')||'<tr><td colspan="4" class="empty">暂无站内信</td></tr>'}</tbody></table></div>${r.hasMore?'<button id="older-messages">更早消息 →</button>':''}`;
      status.textContent='';content.querySelector('#new-message').onclick=()=>void compose();content.querySelectorAll('[data-campaign]').forEach(b=>b.onclick=()=>void preview(b.dataset.campaign));
      content.querySelectorAll('[data-effects]').forEach(b=>b.onclick=()=>{const own=++viewRevision;void showMessageEffects({id:b.dataset.effects,content,status,api,valid:()=>valid(own),back:()=>void list()});});
      const older=content.querySelector('#older-messages');if(older)older.onclick=()=>{offset+=30;void list();};
      if(offset){const previous=document.createElement('button');previous.textContent='← 较新消息';previous.onclick=()=>{offset=Math.max(0,offset-30);void list();};content.append(previous);}
    }catch(e){failure(e);}
  }
  await list();
}
