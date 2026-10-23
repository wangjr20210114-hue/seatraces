/* 管理后台成员、角色和访问权限。 */

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={administrator:'管理员',operator:'运营',support:'客服',analyst:'只读分析'};
export async function mountAdminAccess({content,status,api,isCurrent}) {
  let offset=0,search='',generation=0;
  async function render(){
    const own=++generation;
    try{
      const v=await api('/api/admin/access/members?'+new URLSearchParams({q:search,offset}));if(!isCurrent()||own!==generation)return;
      content.innerHTML=`<article class="admin-card"><h3>后台人员与权限</h3><p>运营管理路线和消息；客服查看用户与行程；分析人员只读汇总。账号在旅行端的身份保持不变。</p></article>
        <form class="filters" id="member-search"><label>查找账号<input name="q" maxlength="80" value="${esc(search)}" placeholder="搜索已有账号以分配权限"></label><button>查询</button></form>
        <div class="table-wrap"><table><thead><tr><th>账号</th><th>昵称</th><th>后台身份</th><th>账号状态</th><th>操作</th></tr></thead><tbody>${v.items.map(u=>`<tr><td>${esc(u.username)}</td><td>${esc(u.nickname)}</td><td>${u.account_role==='admin'?'管理员':u.enabled?labels[u.role]:'无后台权限'}</td><td>${u.disabled_at?'已停用':'正常'}</td><td>${u.account_role==='admin'?'由负责人维护':`<select aria-label="${esc(u.username)}的后台角色" data-role="${u.id}" ${u.disabled_at?'disabled':''}><option value="">无后台权限</option>${Object.entries(labels).filter(([k])=>k!=='administrator').map(([key,name])=>`<option value="${key}" ${u.enabled&&u.role===key?'selected':''}>${name}</option>`).join('')}</select> <button data-save="${u.id}">保存</button>`}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">暂无匹配账号</td></tr>'}</tbody></table></div>
        <div class="pager"><button id="members-prev" ${offset?'':'disabled'}>上一页</button><button id="members-next" ${v.hasMore?'':'disabled'}>下一页</button></div>`;
      content.querySelector('#member-search').onsubmit=e=>{e.preventDefault();search=new FormData(e.target).get('q').trim();offset=0;void render();};
      content.querySelector('#members-prev').onclick=()=>{offset=Math.max(0,offset-30);void render();};
      content.querySelector('#members-next').onclick=()=>{offset+=30;void render();};
      content.querySelectorAll('[data-save]').forEach(button=>button.onclick=async()=>{
        const user=v.items.find(u=>u.id===button.dataset.save),role=content.querySelector(`[data-role="${user.id}"]`).value||null;
        const dialog=document.querySelector('#admin-confirm');dialog.returnValue='cancel';
        document.querySelector('#confirm-title').textContent=`将 ${user.username} 的后台权限设为${labels[role]||'无权限'}？`;
        const reason=document.querySelector('#status-reason').closest('label');reason.hidden=true;dialog.showModal();
        const decision=await new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true}));reason.hidden=false;
        if(decision!=='confirm'||!isCurrent())return;
        button.disabled=true;
        try{await api('/api/admin/access/members/'+user.id,{role,version:user.version,confirmation:'change-role'},'PUT');await render();status.textContent='权限已更新，该账号需要重新登录后台。';}
        catch(e){status.textContent=e.message;button.disabled=false;}
      });status.textContent='';
    }catch(e){if(isCurrent())status.textContent=e.message;}
  }
  await render();
}
