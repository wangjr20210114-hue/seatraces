const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dayAgo=n=>new Date(Date.now()-n*86400000+8*3600000).toISOString().slice(0,10);
const time=v=>new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const mb=n=>Number(n)<1024?Number(n)+' B':Number(n)<1048576?(Number(n)/1024).toFixed(1)+' KB':(Number(n)/1048576).toFixed(2)+' MB';
const table=(heads,rows)=>`<div class="table-wrap"><table><thead><tr>${heads.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.join('')||`<tr><td colspan="${heads.length}" class="empty">暂无归档记录</td></tr>`}</tbody></table></div>`;
export async function mountDailyArchives({content,status,api,isCurrent,canManage=false,openTask}){
  let from=dayAgo(7),to=dayAgo(1),generation=0;
  async function load(){
    const own=++generation;status.textContent='正在读取汇总…';
    try{
      const v=await api('/api/admin/analytics/daily-archives?'+new URLSearchParams({from,to}));if(!isCurrent()||own!==generation)return;
      content.innerHTML=`<form class="filters" id="rollup-filter"><label>开始<input type="date" name="from" value="${from}" required></label><label>结束<input type="date" name="to" value="${to}" required max="${dayAgo(1)}"></label><button class="primary">查看汇总</button></form><p class="coverage-note">${esc(v.scope)}。${esc(v.missingDays)}。</p>${table(['日期','活跃用户','新用户','行程','CityWalk','业务事件','操作日志','5xx','口径'],v.items.map(r=>`<tr><td>${r.day}</td>${['active','registered','trips','citywalks','business_events','operations','errors'].map(k=>`<td>${r.metrics[k]}</td>`).join('')}<td>${r.coverage.partial?'采集不完整':'采集期间'}${r.frozen?' · 归档时快照':''}</td></tr>`))}${canManage?'<form id="rollup-run" class="admin-card form-stack"><h3>生成汇总</h3><p>按上面的日期计算，单次最多31天；已归档的日期保留归档前快照。</p><label class="confirm-inline"><input type="checkbox" required>确认生成所选日期汇总</label><button class="primary">提交汇总任务</button></form>':''}`;
      content.querySelector('#rollup-filter').onsubmit=e=>{e.preventDefault();const d=new FormData(e.target);from=d.get('from');to=d.get('to');void load();};
      const form=content.querySelector('#rollup-run');if(form)form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const r=await api('/api/admin/archives/rollups',{id:crypto.randomUUID(),from,to,confirmation:'summarize-events'});if(isCurrent()&&own===generation)openTask(r.id);}catch(error){if(isCurrent()&&own===generation){status.textContent=error.message;button.disabled=false;}}};
      status.textContent='';
    }catch(error){if(isCurrent()&&own===generation)status.textContent=error.message;}
  }
  await load();
}
export async function mountArchives({content,status,api,isCurrent,policy,openTask}){
  let offset=0,generation=0,stream='operation',from=dayAgo(policy.raw_retention_days+7),to=dayAgo(policy.raw_retention_days+1);
  async function load(){
    const own=++generation;status.textContent='正在读取归档…';
    try{
      const v=await api('/api/admin/archives?'+new URLSearchParams({offset}));if(!isCurrent()||own!==generation)return;
      content.innerHTML=`<div class="metrics"><article class="metric"><span>普通明细保留</span><strong>${policy.raw_retention_days} 天</strong></article><article class="metric"><span>管理员审计保留</span><strong>${policy.adminAuditRetentionDays} 天</strong></article><article class="metric"><span>每日汇总保留</span><strong>${policy.aggregate_retention_months} 个月</strong></article></div><article class="admin-card"><h3>预览事件归档</h3><p>只移动旧事件明细；用户、行程和地点不变。校验成功后分批压缩保存，可下载或恢复。当前不会自动归档。</p><form id="archive-preview" class="filters"><label>日志<select name="stream"><option value="operation">操作日志</option><option value="product">业务事件</option></select></label><label>开始<input name="from" type="date" value="${from}" required></label><label>结束<input name="to" type="date" value="${to}" required></label><button class="primary">预览</button></form><p>日期须早于 ${policy.cutoff_day}；每次最多31天、20,000条。</p><div id="archive-confirm"></div></article><h3>归档包</h3>${table(['范围','日志','条数','原始 / 压缩','状态','操作'],v.items.map(r=>`<tr><td>${time(r.first_at)}<span class="table-secondary">至 ${time(r.last_at)}</span></td><td>${r.stream==='operation'?'操作日志':'业务事件'}</td><td>${r.row_count}</td><td>${mb(r.raw_bytes)} / ${mb(r.compressed_bytes)}</td><td>${r.restored_at?'已恢复':'已归档'}</td><td class="row-actions"><a class="button" href="/api/admin/archives/${r.id}/download" download>下载</a>${r.restored_at?'':`<button data-restore="${r.id}">恢复</button>`}</td></tr>`))}<div id="restore-confirm"></div><div class="pager"><button id="archive-prev" ${offset?'':'disabled'}>上一页</button><span>第 ${offset/30+1} 页</span><button id="archive-next" ${v.hasMore?'':'disabled'}>下一页</button></div><h3>长期汇总</h3><div id="archive-rollups"></div>`;
      const form=content.querySelector('#archive-preview'),confirm=content.querySelector('#archive-confirm');form.querySelector('select').value=stream;
      // Changing the range invalidates a displayed preview/confirmation.
      let previewRevision=0;form.oninput=()=>{previewRevision++;confirm.replaceChildren();};
      form.onsubmit=async e=>{e.preventDefault();const revision=++previewRevision,button=form.querySelector('button');button.disabled=true;confirm.replaceChildren();const data=new FormData(form);stream=data.get('stream');from=data.get('from');to=data.get('to');
        try{const p=await api('/api/admin/archives/preview',{id:crypto.randomUUID(),stream,from,to});if(!isCurrent()||own!==generation||revision!==previewRevision)return;
          confirm.innerHTML=`<form class="form-stack"><p>可归档 <b>${p.rows}</b> 条 · ${mb(p.bytes)} · 预览有效至 ${time(p.expiresAt)}</p>${p.rows?'<label class="confirm-inline"><input type="checkbox" required>确认压缩保存并移出近期日志查询</label><button class="primary">开始归档</button>':''}</form>`;
          if(p.rows)confirm.querySelector('form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;try{const r=await api('/api/admin/archives/start',{id:crypto.randomUUID(),previewId:p.id,confirmation:'archive-events'});if(isCurrent()&&own===generation)openTask(r.id);}catch(error){if(isCurrent()&&own===generation){status.textContent=error.message;b.disabled=false;}}};status.textContent='';
        }catch(error){if(isCurrent()&&own===generation)status.textContent=error.message;}finally{button.disabled=false;}
      };
      content.querySelectorAll('[data-restore]').forEach(b=>b.onclick=()=>{const a=v.items.find(x=>x.id===b.dataset.restore),host=content.querySelector('#restore-confirm');host.innerHTML=`<form class="admin-card form-stack"><h3>恢复 ${a.row_count} 条事件</h3><p>恢复前重新校验完整性；遇到同编号但内容不同的记录会停止，不覆盖当前数据。</p><label class="confirm-inline"><input type="checkbox" required>确认恢复这个归档包</label><button class="primary">提交恢复任务</button></form>`;host.scrollIntoView({behavior:'smooth',block:'nearest'});host.querySelector('form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{const r=await api('/api/admin/archives/'+a.id+'/restore',{id:crypto.randomUUID(),version:a.version,sha256:a.sha256,confirmation:'restore-events'});if(isCurrent()&&own===generation)openTask(r.id);}catch(error){if(isCurrent()&&own===generation){status.textContent=error.message;button.disabled=false;}}};});
      content.querySelector('#archive-prev').onclick=()=>{offset-=30;void load();};content.querySelector('#archive-next').onclick=()=>{offset+=30;void load();};
      await mountDailyArchives({content:content.querySelector('#archive-rollups'),status,api,isCurrent:()=>isCurrent()&&own===generation,canManage:true,openTask});
    }catch(error){if(isCurrent()&&own===generation)status.textContent=error.message;}
  }
  await load();
}
