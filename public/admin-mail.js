const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
const states={queued:'待发送',sending:'发送中',sent:'已受理',retry:'等待重试',failed:'失败',unknown:'结果待确认',expired:'已过期'};
const purposes={verify_email:'邮箱验证',reset_password:'密码重置',password_changed:'密码变更通知'};
function table(head,rows){return `<div class="table-wrap"><table><thead><tr>${head.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')||`<tr><td colspan="${head.length}">暂无记录</td></tr>`}</tbody></table></div>`;}
export async function mountAdminMail({content,status,api,can,isCurrent}){
 let offset=0,revision=0;
 async function render(){
  const own=++revision;status.textContent='正在读取邮件状态…';
  try{
   const [s,j,h]=await Promise.all([api('/api/admin/mail/status'),api('/api/admin/mail/jobs?offset='+offset),api('/api/admin/mail/history')]);
   if(!isCurrent()||own!==revision)return;
   const cfg=s.configuration,counts=Object.fromEntries(s.counts.map(v=>[v.state,v.count]));
   const last=s.lastVerification,verified=last?.metadata?.passed===true;
   content.innerHTML=`<article class="admin-card"><h3>邮件服务</h3><p>渠道：${cfg.provider==='tencent_ses'?'腾讯云 SES API':cfg.provider==='smtp'?'SMTP':'未配置'} · 配置：${cfg.enabled?'已齐备':'未就绪'}</p><p>最近核验：${last?(verified?'通过':'未通过')+' · '+time(last.created_at):'尚未核验'}</p>${cfg.missing.length?`<p>缺少：${esc(cfg.missing.join('、'))}</p>`:''}${cfg.invalid?.length?`<p>无效配置：${esc(cfg.invalid.join('、'))}</p>`:''}${can('system.manage')?'<button class="primary" id="mail-check">核验域名与模板</button>':''}<p id="mail-check-result" role="status"></p></article><div class="metrics">${Object.entries(states).map(([k,v])=>`<article class="metric"><span>${v}</span><strong>${counts[k]||0}</strong></article>`).join('')}</div><article class="admin-card"><h3>邮件投递记录</h3><p>“已受理”表示发信服务接受请求，实际到达收件箱需要收信确认。</p>${table(['编号','用途','状态','尝试次数','安全错误码','创建时间','更新时间'],j.items.map(v=>`<tr><td>${esc(v.id)}</td><td>${esc(purposes[v.purpose]||v.purpose)}</td><td>${esc(states[v.state]||v.state)}</td><td>${v.attempts}</td><td>${esc(v.last_error||'—')}</td><td>${time(v.created_at)}</td><td>${time(v.updated_at)}</td></tr>`))}<div class="pager"><button id="mail-prev" ${offset?'':'disabled'}>上一页</button><span>第 ${offset/30+1} 页</span><button id="mail-next" ${j.items.length===30&&offset<9990?'':'disabled'}>下一页</button></div></article><article class="admin-card"><h3>配置与投递日志</h3>${table(['时间','事件','结果','错误码'],h.items.map(v=>`<tr><td>${time(v.created_at)}</td><td>${esc(v.action)}</td><td>${esc(v.metadata?.passed===true?'通过':v.metadata?.passed===false?'未通过':states[v.action.split('.').at(-1)]||'已记录')}</td><td>${esc(v.metadata?.code||'—')}</td></tr>`))}</article>`;
   content.querySelector('#mail-prev').onclick=()=>{offset-=30;void render();};
   content.querySelector('#mail-next').onclick=()=>{offset+=30;void render();};
   const check=content.querySelector('#mail-check');
   if(check)check.onclick=async()=>{
    check.disabled=true;status.textContent='正在核验，不发送邮件…';
    try{const r=await api('/api/admin/mail/verify',{});if(!isCurrent()||own!==revision)return;await render();if(isCurrent())content.querySelector('#mail-check-result').textContent=r.passed?'核验通过':`核验未通过：${r.code}`;}
    catch(e){if(isCurrent()&&own===revision){status.textContent=e.message;check.disabled=false;}}
   };
   status.textContent='';
  }catch(e){if(isCurrent()&&own===revision)status.textContent=e.message;}
 }
 await render();
}
