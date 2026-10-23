/* 展示后台列表条目的详细信息。 */

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
export function createAdminDetails({api,status,can=()=>true}) {
  const dialog=document.querySelector('#admin-detail'),body=dialog.querySelector('.detail-body');let revision=0;
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>revision++);
  const fields=items=>`<dl class="detail-grid">${items.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  async function open(kind,id){
    const own=++revision;body.textContent='正在加载…';dialog.querySelector('h2').textContent=kind==='user'?'用户详情':'日志详情';if(!dialog.open)dialog.showModal();
    try{
      const v=await api('/api/admin/'+(kind==='user'?'users/':'events/')+id);if(own!==revision||!dialog.open)return;
      if(kind==='event'){
        body.innerHTML=fields([['操作',v.action],['时间',time(v.created_at)],['账号',v.username||'系统'],['类别',v.kind],['资源 ID',v.resource_id||'—'],['请求 ID',v.request_id||'—'],['状态码',v.status??'—'],['耗时',v.duration_ms===null?'—':v.duration_ms+' ms']])+`<h3>审计信息</h3><pre class="code-block">${esc(JSON.stringify(v.metadata,null,2))}</pre>`;
        return;
      }
      const u=v.user;
      body.innerHTML=fields([['账号',u.username],['昵称',u.nickname],['用户 ID',u.id],['身份',u.role==='admin'?'管理员':'用户'],['账号状态',u.disabled_at?'已停用':'正常'],['注册时间',time(u.created_at)],['密码更新时间',time(u.password_changed_at)],['找回邮箱',u.email_verified?'已验证':'未绑定'],['操作记录',u.operation_count],['最近操作',time(u.last_operation_at)]])+`<h3>有效登录会话</h3><div class="table-wrap"><table><thead><tr><th>创建时间</th><th>到期时间</th></tr></thead><tbody>${v.sessions.map(s=>`<tr><td>${time(s.created_at)}</td><td>${time(s.expires_at)}</td></tr>`).join('')||'<tr><td colspan="2">无有效会话</td></tr>'}</tbody></table></div>${v.hasMoreSessions?'<p>仅显示最近 100 个会话</p>':''}${u.role==='admin'?'':`<details class="session-action"><summary>撤销该用户全部登录会话</summary><p>用户需要重新登录，账号与行程保留。</p><label>操作原因<select id="revoke-reason"><option value="security">安全处理</option><option value="support">账号维护</option><option value="requested">用户申请</option></select></label><button class="danger" id="revoke-sessions" ${v.sessions.length?'':'disabled'}>确认退出全部会话</button><p role="status" id="revoke-result"></p></details>`}`;
      if(!can('users.manage'))body.querySelector('.session-action')?.remove();
      const button=body.querySelector('#revoke-sessions');
      if(button)button.onclick=async()=>{
        button.disabled=true;const result=body.querySelector('#revoke-result');result.textContent='正在撤销…';
        try{const r=await api('/api/admin/users/'+id+'/sessions/revoke',{confirmation:'revoke',reason:body.querySelector('#revoke-reason').value});if(own!==revision)return;await open('user',id);const target=body.querySelector('#revoke-result');if(target){target.textContent=`已撤销 ${r.revoked} 个会话`;target.closest('details').open=true;}}
        catch(e){if(own===revision){result.textContent=e.message;button.disabled=false;}}
      };
    }catch(e){if(own===revision)body.textContent=e.message;status.textContent=e.message;}
  }
  return {user:id=>open('user',id),event:id=>open('event',id)};
}
