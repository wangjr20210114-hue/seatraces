const $=s=>document.querySelector(s);
export const escapeText=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const esc=escapeText;
const names={overview:'总览',users:'用户',events:'操作日志',tasks:'任务'};
let section='overview',offset=0,revision=0,userQuery='',filters={};
const content=$('#admin-content'),status=$('#admin-status');
async function api(url,body,method) {
  const response=await fetch(url,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Seatraces':'1'},...(body?{body:JSON.stringify(body)}:{})});
  if(response.status===401){location.replace('/login.html?next=admin');throw Error('请先登录');}
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'暂时无法完成');
  return data;
}
const time=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
function table(head,rows){return `<div class="table-wrap"><table><thead><tr>${head.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.join('')||`<tr><td colspan="${head.length}" class="empty">暂无记录</td></tr>`}</tbody></table></div>`;}
function pager(more){content.insertAdjacentHTML('beforeend',`<div class="pager"><button id="previous" ${offset?'':'disabled'}>上一页</button><span>第 ${offset/30+1} 页</span><button id="next" ${more?'':'disabled'}>下一页</button></div>`);$('#previous').onclick=()=>{offset=Math.max(0,offset-30);void render();};$('#next').onclick=()=>{offset+=30;void render();};}
async function confirmUser(user){
  const dialog=$('#admin-confirm');$('#confirm-title').textContent=(user.disabled_at?'启用 ':'停用 ')+user.username+'？';
  dialog.returnValue='cancel';dialog.showModal();
  const decision=await new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true}));
  if(decision!=='confirm')return;
  try{await api('/api/admin/users/'+user.id+'/status',{disabled:!user.disabled_at,reason:$('#status-reason').value},'PATCH');await render();}catch(e){status.textContent=e.message;}
}
async function render(){
  const own=++revision;$('#section-title').textContent=names[section];status.textContent='正在加载…';$('#refresh').disabled=true;
  content.replaceChildren();
  document.querySelectorAll('[data-section]').forEach(b=>b.setAttribute('aria-current',b.dataset.section===section?'page':'false'));
  try{
    if(section==='overview'){
      const v=await api('/api/admin/overview');if(own!==revision)return;
      content.innerHTML=`<div class="metrics">${[['用户',v.counts.users],['停用账号',v.counts.disabled],['今日操作',v.counts.events],['今日错误',v.counts.errors]].map(([a,b])=>`<article class="metric"><span>${a}</span><strong>${b}</strong></article>`).join('')}</div><article class="admin-card"><h3>服务状态</h3><p>数据库已连接 · 已运行 ${Math.floor(v.health.uptimeSeconds/60)} 分钟 · 内存 ${v.health.rssMB} MB</p><p>待写日志 ${v.logs.queued} · 丢弃 ${v.logs.dropped} · 写入失败 ${v.logs.failed}</p></article>`;
    }else if(section==='users'){
      const v=await api('/api/admin/users?'+new URLSearchParams({q:userQuery,offset}));if(own!==revision)return;
      content.innerHTML=`<form class="filters" id="user-filter"><label>查找用户<input name="q" value="${esc(userQuery)}" placeholder="账号 / 昵称" maxlength="80"></label><button>查询</button></form>`+table(['账号','昵称','身份','状态','注册时间','操作'],v.items.map(u=>`<tr><td>${esc(u.username)}</td><td>${esc(u.nickname)}</td><td>${u.role==='admin'?'管理员':'用户'}</td><td><span class="badge ${u.disabled_at?'paused':''}">${u.disabled_at?'已停用':'正常'}</span></td><td>${time(u.created_at)}</td><td><button data-user="${u.id}" ${u.role==='admin'?'disabled':''}>${u.disabled_at?'启用':'停用'}</button> <button data-trace="${u.id}">轨迹</button></td></tr>`));
      $('#user-filter').onsubmit=e=>{e.preventDefault();userQuery=new FormData(e.target).get('q');offset=0;void render();};
      content.querySelectorAll('[data-user]').forEach(b=>b.onclick=()=>void confirmUser(v.items.find(u=>u.id===b.dataset.user)));
      content.querySelectorAll('[data-trace]').forEach(b=>b.onclick=()=>{section='events';filters={userId:b.dataset.trace};offset=0;void render();});pager(v.hasMore);
    }else if(section==='events'){
      const v=await api('/api/admin/events?'+new URLSearchParams({...filters,offset}));if(own!==revision)return;
      content.innerHTML=`<form id="log-filter" class="filters"><label>开始<input type="date" name="from" value="${esc(filters.from||'')}"></label><label>结束<input type="date" name="to" value="${esc(filters.to||'')}"></label><label>类型<select name="kind"><option value="">全部</option><option value="navigation">页面轨迹</option><option value="request">接口操作</option><option value="admin">管理审计</option><option value="system">系统错误</option></select></label><button>筛选</button><button type="button" id="clear-filter">清除</button><button type="button" id="export">下载日志 ↓</button></form>`+table(['时间','用户','类型','操作','状态 / 耗时'],v.items.map(e=>`<tr><td>${time(e.created_at)}</td><td>${esc(e.username||'系统')}</td><td>${esc(e.kind)}</td><td>${esc(e.action)}</td><td>${e.status||'—'}${e.duration_ms===null?'':` / ${e.duration_ms}ms`}</td></tr>`));
      $('#log-filter select').value=filters.kind||'';
      $('#log-filter').onsubmit=e=>{e.preventDefault();filters={...(filters.userId?{userId:filters.userId}:{}),...Object.fromEntries([...new FormData(e.target)].filter(([,v])=>v))};offset=0;void render();};
      $('#clear-filter').onclick=()=>{filters={};offset=0;void render();};
      $('#export').onclick=async()=>{const b=$('#export');b.disabled=true;try{const r=await fetch('/api/admin/events/export?'+new URLSearchParams(filters));if(!r.ok)throw Error((await r.json()).error);const url=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=url;a.download='seatraces-operations.log.gz';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){status.textContent=e.message;}finally{b.disabled=false;}};pager(v.hasMore);
    }else if(section==='tasks'){
      const v=await api('/api/admin/tasks');if(own!==revision)return;
      content.innerHTML=table(['来源','条数','状态','创建时间'],v.items.map(j=>`<tr><td>${esc(j.source)}</td><td>${j.rows_count}</td><td>${esc(j.status)}</td><td>${time(j.created_at)}</td></tr>`));
    }
    status.textContent='';
  }catch(e){if(own===revision)status.textContent=e.message;}
  finally{if(own===revision)$('#refresh').disabled=false;}
}
document.querySelectorAll('[data-section]').forEach(b=>b.onclick=()=>{section=b.dataset.section;offset=0;void render();});
$('#refresh').onclick=()=>void render();
try{const me=await api('/api/me');if(!me.user)location.replace('/login.html?next=admin');else if(me.user.role!=='admin'){status.textContent='此账号没有后台权限';$('nav').hidden=true;$('#refresh').hidden=true;}else{$('#admin-name').textContent=me.user.nickname;await render();}}catch(e){status.textContent=e.message;}
