const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const states={queued:'排队中',running:'正在导出',completed:'已完成',failed:'失败',interrupted:'已中断',cancelled:'已取消'};
const errors={EXPORT_SOURCE_CHANGED:'所选日志已变化，请重新导出',EXPORT_ACCESS_REVOKED:'导出权限已失效',EXPORT_OVERSIZE:'日志体积超限，请缩小范围',EXPORT_EXPIRED:'文件已过期',TASK_FAILED:'导出失败，请按任务编号排查',WORKER_INTERRUPTED:'服务执行中断，请重新导出'};
export async function mountLogExports({host,api,isCurrent,getFilters}){
 let request=null,sequence=0,timer;
 host.innerHTML='<section class="admin-card"><div class="log-toolbar"><strong>我的日志导出</strong><button class="primary" id="log-export-start">导出当前筛选</button><button id="log-export-refresh">刷新任务</button></div><p class="muted">压缩日志保留 24 小时，仅创建者可下载。</p><div id="log-export-status" role="status"></div><div id="log-export-list"></div></section>';
 const $=s=>host.querySelector(s);
 async function load(){
  const n=++sequence;clearTimeout(timer);
  try{
   const data=await api('/api/admin/events/exports');if(!isCurrent()||n!==sequence)return;
   $('#log-export-list').innerHTML=data.items.map(t=>{
    const done=t.state==='completed'?t.total_rows:t.progress?.completedRows||0;
    return `<article class="log-export-task"><div><strong>${states[t.state]||esc(t.state)}</strong> · ${done} / ${t.total_rows} 条 <span>${esc(new Date(t.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}))}</span></div>
      ${['queued','running'].includes(t.state)?`<progress aria-label="导出进度" max="${Math.max(1,t.total_rows)}" value="${done}"></progress>`:''}
      ${t.error_code?`<p>${esc(errors[t.error_code]||'任务未完成，请重新创建导出')}</p>`:''}
      <div class="log-export-bottom"><code>${esc(t.id)}</code>${t.state==='completed'?`<button data-download="${t.id}">下载 log.gz</button>`:''}</div></article>`;
   }).join('')||'<p class="empty">暂无导出任务</p>';
   host.querySelectorAll('[data-download]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{
    const task=await api('/api/admin/events/exports/'+b.dataset.download);if(!isCurrent())return;if(task.state!=='completed')throw Error('任务尚未完成');
    const a=document.createElement('a');a.href='/api/admin/events/exports/'+task.id+'/file';a.download='seatraces-operations-'+task.id+'.log.gz';document.body.append(a);a.click();a.remove();
   }catch(e){if(isCurrent())$('#log-export-status').textContent=e.message;}finally{if(isCurrent())b.disabled=false;}});
   if(data.items.some(t=>['queued','running'].includes(t.state)))timer=setTimeout(()=>{if(isCurrent()&&!document.hidden)void load();},2000);
  }catch(e){if(isCurrent()&&n===sequence)$('#log-export-status').textContent=e.message;}
 }
 $('#log-export-start').onclick=async()=>{const b=$('#log-export-start');b.disabled=true;b.textContent='正在提交…';try{
  const filters=getFilters(),key=JSON.stringify(filters);if(!request||request.key!==key)request={id:crypto.randomUUID(),key,filters};
  const r=await api('/api/admin/events/exports',{id:request.id,filters:request.filters});request=null;if(!isCurrent())return;
  $('#log-export-status').textContent='导出已受理 · '+r.totalRows+' 条';await load();
 }catch(e){if(isCurrent())$('#log-export-status').textContent=e.message;}finally{if(isCurrent()){b.disabled=false;b.textContent='导出当前筛选';}}};
 $('#log-export-refresh').onclick=()=>void load();await load();
}
