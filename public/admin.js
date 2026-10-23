/* 组织后台导航、权限检查和各管理页面。 */

import {mountLogExplorer} from './admin-log-explorer.js';
import {mountAdminCityWalks} from './admin-citywalks.js';
import {createAdminDetails} from './admin-details.js';
import {mountAdminMessages} from './admin-messages.js';
import {mountAdminAccess} from './admin-access.js';
import {mountAdminUser} from './admin-user.js';
import {mountAdminAnalytics} from './admin-analytics.js';
import {mountAdminAgent} from './admin-agent.js';
import {mountModeration} from './admin-moderation.js';
import {mountMaintenance} from './admin-maintenance.js';
import {mountPlaceQuality} from './admin-place-quality.js';
import {mountAdminJourneys} from './admin-journeys.js';
import {mountAdminMail} from './admin-mail.js';
const $=s=>document.querySelector(s);
export const escapeText=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const esc=escapeText;
const names={overview:'总览',analytics:'运营分析',journeys:'旅行与路线',quality:'地点质量',content:'内容治理',agent:'智能体执行链',users:'用户',events:'操作日志',tasks:'任务',messages:'站内信',mail:'邮件投递',classics:'经典 CityWalk',access:'权限与人员'};
const sectionPermissions={overview:'overview.read',analytics:'analytics.read',journeys:'journeys.read',quality:'places.read',content:'content.manage',agent:'agent.read',users:'users.list',events:'events.read',tasks:'tasks.read',messages:'messages.manage',mail:'system.read',classics:'classics.manage',access:'roles.manage'};
let access=null;
const can=permission=>!!access&&(access.permissions.includes('*')||access.permissions.includes(permission));
let section='overview',offset=0,revision=0,userQuery='',userState='all',userRole='all',filters={};
let userId='',userTab='overview';
function navigate(next,id='',tab='overview'){
  const hash='#/'+next+(id?'/'+id+'/'+tab:'');
  if(location.hash===hash){void render();return;}location.hash=hash;
}
function readRoute(){
  const parts=location.hash.split('?')[0].replace(/^#\/?/,'').split('/');section=names[parts[0]]?parts[0]:'overview';
  userId=['users','agent','journeys'].includes(section)&&/^[a-f\d-]{36}$/.test(parts[1]||'')?parts[1]:'';userTab=parts[2]||'overview';offset=0;
}
const content=$('#admin-content'),status=$('#admin-status');
async function api(url,body,method) {
  const response=await fetch(url,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Seatraces':'1'},...(body?{body:JSON.stringify(body)}:{})});
  if(response.status===401){leave();throw Error('请登录管理后台');}
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'暂时无法完成');
  return data;
}
const details=createAdminDetails({api,status,can});
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
    if(section==='users'&&userId){
      $('#section-title').textContent='用户全景';
      await mountAdminUser({content,status,api,id:userId,tab:userTab,isCurrent:()=>revision===own,navigate,details,can});return;
    }else if(section==='overview'){
      const v=await api('/api/admin/overview');if(own!==revision)return;
      content.innerHTML=`<div class="metrics">${[['用户',v.counts.users],['停用账号',v.counts.disabled],['24 小时操作',v.counts.events],['24 小时错误',v.counts.errors]].map(([a,b])=>`<article class="metric"><span>${a}</span><strong>${b}</strong></article>`).join('')}</div>${v.health?`<article class="admin-card"><h3>服务状态</h3><p>数据库已连接 · 已运行 ${Math.floor(v.health.uptimeSeconds/60)} 分钟 · 内存 ${v.health.rssMB} MB</p><p>待写日志 ${v.logs.queued} · 丢弃 ${v.logs.dropped} · 写入失败 ${v.logs.failed}</p></article>`:''}`;
    }else if(section==='users'){
      const v=await api('/api/admin/users?'+new URLSearchParams({q:userQuery,state:userState,role:userRole,offset}));if(own!==revision)return;
      content.innerHTML=`<form class="filters" id="user-filter"><label>查找用户<input name="q" value="${esc(userQuery)}" placeholder="账号 / 昵称" maxlength="80"></label><label>状态<select name="state"><option value="all">全部状态</option><option value="active">正常</option><option value="disabled">已停用</option></select></label><label>身份<select name="role"><option value="all">全部身份</option><option value="user">普通用户</option><option value="admin">管理员</option></select></label><button class="primary">查询</button></form>`+table(['账号','昵称','身份','状态','注册时间','操作'],v.items.map(u=>`<tr><td>${esc(u.username)}</td><td>${esc(u.nickname)}</td><td>${u.role==='admin'?'管理员':'用户'}</td><td><span class="badge ${u.disabled_at?'paused':''}">${u.disabled_at?'已停用':'正常'}</span></td><td>${time(u.created_at)}</td><td class="row-actions"><button data-detail="${u.id}">详情</button> <button data-user="${u.id}" ${u.role==='admin'?'disabled':''}>${u.disabled_at?'启用':'停用'}</button> <button data-trace="${u.id}">轨迹</button></td></tr>`));
      $('#user-filter select[name=state]').value=userState;$('#user-filter select[name=role]').value=userRole;
      content.querySelectorAll('[data-detail]').forEach(b=>{b.textContent='用户全景';b.onclick=()=>navigate('users',b.dataset.detail);});
      content.querySelectorAll('[data-detail]').forEach(b=>b.hidden=!can('users.read'));
      content.querySelectorAll('[data-user]').forEach(b=>b.hidden=!can('users.manage'));
      content.querySelectorAll('[data-trace]').forEach(b=>b.hidden=!can('events.read'));
      $('#user-filter').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);userQuery=f.get('q');userState=f.get('state');userRole=f.get('role');offset=0;void render();};
      content.querySelectorAll('[data-user]').forEach(b=>b.onclick=()=>void confirmUser(v.items.find(u=>u.id===b.dataset.user)));
      content.querySelectorAll('[data-trace]').forEach(b=>b.onclick=()=>navigate('users',b.dataset.trace,'timeline'));pager(v.hasMore);
    }else if(section==='events'){
      await mountLogExplorer({content,status,api,isCurrent:()=>revision===own,can,details,navigate});return;
    }else if(section==='content'){
      await mountModeration({content,status,api,isCurrent:()=>revision===own});return;
    }else if(section==='quality'){
      await mountPlaceQuality({content,status,api,can,isCurrent:()=>revision===own});return;
    }else if(section==='journeys'){
      await mountAdminJourneys({content,status,api,id:userId,tab:userTab,isCurrent:()=>revision===own,navigate});return;
    }else if(section==='agent'){
      await mountAdminAgent({content,status,api,id:userTab==='user'?'':userId,filterUser:userTab==='user'?userId:'',isCurrent:()=>revision===own,navigate});return;
    }else if(section==='analytics'){
      await mountAdminAnalytics({content,status,api,can,isCurrent:()=>revision===own});return;
    }else if(section==='access'){
      await mountAdminAccess({content,status,api,isCurrent:()=>revision===own});return;
    }else if(section==='mail'){
      await mountAdminMail({content,status,api,can,isCurrent:()=>revision===own});return;
    }else if(section==='messages'){
      await mountAdminMessages({content,status,api,isCurrent:()=>revision===own});
      return;
    }else if(section==='classics'){
      await mountAdminCityWalks({content,status,api,isCurrent:()=>revision===own});return;
    }else if(section==='tasks'){
      await mountMaintenance({content,status,api,isCurrent:()=>revision===own});return;
    }
    status.textContent='';
  }catch(e){if(own===revision)status.textContent=e.message;}
  finally{if(own===revision)$('#refresh').disabled=false;}
}
document.querySelectorAll('[data-section]').forEach(b=>b.onclick=()=>navigate(b.dataset.section));
window.addEventListener('hashchange',()=>{readRoute();window.scrollTo({top:0});if(access)void render();});
$('#refresh').onclick=()=>void render();
function leave(){document.body.hidden=true;location.replace('/admin-login.html');}
$('#admin-logout').onclick=async()=>{
  $('#admin-logout').disabled=true;
  try{await api('/api/auth/admin/logout',{});leave();}
  catch(e){status.textContent=e.message;$('#admin-logout').disabled=false;}
};
window.addEventListener('pagehide',()=>{document.body.hidden=true;});
window.addEventListener('pageshow',e=>{if(e.persisted)location.reload();});
let expiryTimer;
async function verifySession(){
  const me=await api('/api/auth/admin/me');
  if(!me.user||!me.access){leave();return false;}
  access=me.access;
  document.querySelectorAll('[data-section]').forEach(b=>b.hidden=!can(sectionPermissions[b.dataset.section]));
  if(!can(sectionPermissions[section])){section='overview';offset=0;void render();}
  clearTimeout(expiryTimer);
  expiryTimer=setTimeout(leave,Math.max(0,new Date(me.expiresAt).getTime()-Date.now()));
  $('#admin-name').textContent=me.user.nickname;
  return true;
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void verifySession().catch(()=>leave());});
setInterval(()=>{if(!document.hidden)void verifySession().catch(()=>leave());},60000);
try{readRoute();if(await verifySession())await render();}catch(e){status.textContent='无法核验后台登录，请刷新重试';$('nav').hidden=true;$('#refresh').hidden=true;}
