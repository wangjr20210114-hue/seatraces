const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未记录';
const ms=v=>v===null||v===undefined?'未记录':v+' ms';
const intent={operate:'操作软件',software_question:'询问软件',other:'其他',clarify:'需要澄清'};
const states={running:'处理中',pending:'待确认',executing:'执行中',completed:'成功',failed:'失败',unknown:'结果待核对',cancelled:'已取消',http_success:'HTTP 成功',http_error:'HTTP 失败',network_error:'连接失败'};
const turnStates={running:'处理中',completed:'已回复',failed:'处理失败'};
const table=(head,rows)=>`<div class="table-wrap"><table><thead><tr>${head.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.join('')||`<tr><td colspan="${head.length}" class="empty">暂无记录</td></tr>`}</tbody></table></div>`;
export async function mountAdminAgent({content,status,api,isCurrent,id='',filterUser='',navigate}){
  let offset=0,filters=filterUser?{userId:filterUser}:{},generation=0;
  async function render(){
    const own=++generation;status.textContent='正在读取执行记录…';
    try{
      if(!id){
        const v=await api('/api/admin/agent/conversations?'+new URLSearchParams({...filters,offset}));if(!isCurrent()||own!==generation)return;
        content.innerHTML=`<form class="filters" id="agent-filter"><label>开始<input name="from" type="date" value="${esc(filters.from||'')}"></label><label>结束<input name="to" type="date" value="${esc(filters.to||'')}"></label><label>状态<select name="state"><option value="all">全部</option><option value="issues">失败 / 待核对</option><option value="pending">等待确认</option></select></label><button>查询</button>${filterUser?'<button type="button" id="all-agent-users">全部用户</button>':''}</form>`+
          table(['账号','最近意图','轮数','失败轮次','失败 / 待核对操作','更新时间',''],v.items.map(c=>`<tr><td>${esc(c.username)}</td><td>${esc(intent[c.latest_intent]||'尚未判断')}</td><td>${c.turns}</td><td>${c.failed_turns}</td><td>${c.unresolved_actions}</td><td>${time(c.updated_at)}</td><td><button data-trace="${c.id}">执行链</button></td></tr>`));
        content.querySelector('[name=state]').value=filters.state||'all';
        content.querySelector('form').onsubmit=e=>{e.preventDefault();filters={...(filterUser?{userId:filterUser}:{}),...Object.fromEntries([...new FormData(e.target)].filter(([,v])=>v))};offset=0;void render();};
        content.querySelector('#all-agent-users')?.addEventListener('click',()=>navigate('agent'));
        content.querySelectorAll('[data-trace]').forEach(b=>b.onclick=()=>navigate('agent',b.dataset.trace));pager(v.hasMore);
      }else{
        const v=await api('/api/admin/agent/conversations/'+id+'?'+new URLSearchParams({offset}));if(!isCurrent()||own!==generation)return;
        content.innerHTML=`<div class="user-breadcrumb"><button id="back-agent">← 会话列表</button><span>${esc(v.conversation.username)} · ${v.conversation.revision} 次更新</span></div><div class="coverage-note">只显示流程证据，不展示原始对话、工具参数和密钥。历史未关联调用单列。</div>
          <ol class="agent-traces">${[...v.turns].reverse().map(t=>{
            const tools=v.tools.filter(x=>x.turn_id===t.id),requests=new Set([t.serverRequestId,...tools.flatMap(x=>[x.request_id,x.parent_request_id])].filter(Boolean)),effects=v.effects.filter(e=>requests.has(e.request_id));
            return `<li class="admin-card"><div class="trace-heading"><h3>${esc(intent[t.intent]||'未记录意图')}</h3><span class="badge ${t.status==='failed'?'paused':''}">${esc(turnStates[t.status]||t.status)}</span></div><p class="muted">${time(t.createdAt)} · ${ms(t.durationMs)}</p>
              <div class="trace-facts"><span>分类来源：${esc(t.classification.source||'未记录')}</span><span>置信度：${t.classification.confidence===null?'未记录':Math.round(t.classification.confidence*100)+'%'}</span>${t.clarification?`<span>主动澄清 · ${t.optionCount} 个选项</span>`:''}${t.retrieval?`<span>检索：${esc(t.retrieval)}</span>`:''}</div>
              ${t.steps.length?`<div class="trace-steps">${t.steps.map(s=>`<span>${esc(s)}</span>`).join('<b>→</b>')}</div>`:''}
              ${t.sources.length?`<h4>引用知识</h4><ul>${t.sources.map(s=>`<li>${esc(s.title||s.id)} · ${esc(s.version||t.knowledgeVersion||'未记录版本')}</li>`).join('')}</ul>`:''}
              ${tools.length?`<h4>内部接口调用</h4>${toolTable(tools)}`:'<p class="muted">本轮没有已关联的接口调用。</p>'}
              ${effects.length?`<h4>已提交的业务事件</h4>${table(['事件','资源','版本','时间'],effects.map(e=>`<tr><td>${esc(e.event_type)}</td><td>${esc(e.resource_type)}<span class="table-secondary">${esc(e.resource_id)}</span></td><td>${e.entity_version??'—'}</td><td>${time(e.created_at)}</td></tr>`))}`:''}
              <details class="metric-definitions"><summary>关联编号</summary><p>轮次 ${esc(t.id)}</p><p>客户端幂等请求 ${esc(t.requestId)}</p><p>服务器请求 ${esc(t.serverRequestId||'未记录')}</p>${tools.filter(x=>x.request_id).map(x=>`<p>内部接口请求 ${esc(x.request_id)}</p>`).join('')}</details></li>`;
          }).join('')||'<li class="empty">暂无轮次</li>'}</ol>`;
        content.querySelector('#back-agent').onclick=()=>navigate('agent');pager(v.hasMore);
        content.insertAdjacentHTML('beforeend',`<h3 class="section-caption">确认操作</h3>${table(['能力','状态','创建时间','结束时间'],v.actions.map(a=>`<tr><td>${esc(a.capability)}</td><td>${a.status==='pending'&&new Date(a.expires_at)<new Date()?'确认已过期':esc(states[a.status]||a.status)}</td><td>${time(a.created_at)}</td><td>${time(a.finished_at)}</td></tr>`))}<p class="table-note">${v.effectsArchived?'部分关联业务事件已归档，恢复后可查看；当前列表不代表完整执行结果。':''}Token 和模型账单未单独采集，不显示为零。${v.toolsTruncated||v.effectsTruncated||v.actionsTruncated?'本会话记录较多，部分列表已截断。':''}</p>`);
        const legacy=v.tools.filter(x=>!x.turn_id);if(legacy.length)content.insertAdjacentHTML('beforeend',`<h3 class="section-caption">历史未关联调用</h3>${toolTable(legacy)}`);
      }
      status.textContent='';
    }catch(e){if(isCurrent()&&own===generation)status.textContent=e.message;}
  }
  function toolTable(tools){return table(['接口','结果','耗时'],tools.map(x=>`<tr><td>${esc(x.method+' '+x.path)}</td><td>${x.status??'—'} · ${esc(states[x.outcome]||'未记录结果')}</td><td>${ms(x.duration_ms)}</td></tr>`));}
  function pager(more){content.insertAdjacentHTML('beforeend',`<div class="pager"><button id="agent-prev" ${offset?'':'disabled'}>上一页</button><span>第 ${offset/20+1} 页</span><button id="agent-next" ${more?'':'disabled'}>下一页</button></div>`);content.querySelector('#agent-prev').onclick=()=>{offset=Math.max(0,offset-20);void render();};content.querySelector('#agent-next').onclick=()=>{offset+=20;void render();};}
  await render();
}
