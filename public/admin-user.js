const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'暂无记录';
const labels={overview:'概览',timeline:'操作轨迹',trips:'历史行程',citywalks:'CityWalk',preferences:'旅行偏好',visits:'想去与到访',messages:'消息'};
const styles={pace:'旅行节奏',transport:'交通偏好',crowd:'拥挤偏好',revisit:'重游偏好',interests:'兴趣',relaxed:'慢慢逛',balanced:'均衡',full:'充实',fewTransfers:'少换乘',fewWalking:'少走路',avoid:'避开拥挤',lively:'接受热闹',new:'探索新地方',either:'可以重游'};
const value=v=>Array.isArray(v)?v.map(x=>styles[x]||x).join('、'):styles[v]||String(v??'—');
const table=(columns,rows)=>`<div class="table-wrap"><table><thead><tr>${columns.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.join('')||`<tr><td class="empty" colspan="${columns.length}">暂无记录</td></tr>`}</tbody></table></div>`;
const actions={'trip.saved':'保存行程','trip.version_saved':'保存行程新版本','citywalk.saved':'保存 CityWalk','home.open':'打开旅行首页','agent.open':'打开问 AI','history.open':'查看历史行程','citywalk.open':'打开 CityWalk','services.open':'查看附近吃住'};
Object.assign(actions,{'POST /api/journey/sessions':'开始规划旅行','POST /api/journey/sessions/:id/cities/:cityId':'加载城市游玩区域','POST /api/journey/sessions/:id/questions':'准备个性化问题','POST /api/journey/sessions/:id/generate':'生成旅行方案','POST /api/journey/sessions/:id/wishes':'更新想去地点','POST /api/citywalk/preview':'预览步行路线','POST /api/citywalks':'保存 CityWalk','PUT /api/citywalks/:id':'修改 CityWalk','POST /api/agent/conversations':'开始 AI 会话'});
Object.assign(actions,{'journey.started':'创建旅行规划','journey.candidates_loaded':'城市候选地点已准备','journey.questions_ready':'个性化问题已准备','journey.completed':'旅行规划已生成并保存','trip.updated':'更新行程','trip.status_changed':'更改行程状态','citywalk.started':'创建 CityWalk 编辑草稿','citywalk.updated':'更新 CityWalk','memory.confirmed':'确认旅行偏好','agent.action_prepared':'准备 AI 操作','agent.action_executing':'执行 AI 操作','agent.action_completed':'AI 操作完成','agent.action_cancelled':'取消 AI 操作','agent.action_failed':'AI 操作失败','agent.action_unknown':'AI 操作结果待核对'});
export async function mountAdminUser({content,status,api,id,tab='overview',isCurrent,navigate,details}) {
  const [tabName,search='']=tab.split('?');tab=tabName;
  if(!labels[tab])tab='overview';
  const v=await api('/api/admin/users/'+id+'/summary');if(!isCurrent())return;
  const u=v.user,c=v.counts;let offset=0,filters={},visitKind=new URLSearchParams(search).get('kind')||'wishes',generation=0;
  if(!['wishes','marked','presence','favorites'].includes(visitKind))visitKind='wishes';
  content.innerHTML=`<div class="user-breadcrumb"><button id="back-users">← 用户列表</button><span>用户全景</span></div>
    <article class="user-heading"><div class="user-avatar">${esc(u.avatar)}</div><div><h2>${esc(u.nickname)}</h2><p>${esc(u.username)} <span class="badge ${u.disabled_at?'paused':''}">${u.disabled_at?'已停用':'正常'}</span></p></div><button id="user-account">账号与会话</button></article>
    <div class="user-meta"><span>注册 ${time(u.created_at)}</span><span>最近操作 ${time(c.last_activity_at)}</span><span>邮箱${u.email_verified?'已验证':'未绑定'}</span></div>
    <div class="admin-tabs" role="tablist" aria-label="用户资料">${Object.entries(labels).map(([key,name])=>`<button role="tab" aria-selected="${key===tab}" data-tab="${key}">${name}</button>`).join('')}</div><section id="user-panel"></section>`;
  content.querySelector('#back-users').onclick=()=>navigate('users');
  content.querySelector('#user-account').onclick=()=>void details.user(id);
  content.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>navigate('users',id,b.dataset.tab));
  const panel=content.querySelector('#user-panel');
  function pager(more){
    panel.insertAdjacentHTML('beforeend',`<div class="pager"><button id="user-prev" ${offset?'':'disabled'}>上一页</button><span>第 ${offset/30+1} 页</span><button id="user-next" ${more?'':'disabled'}>下一页</button></div>`);
    panel.querySelector('#user-prev').onclick=()=>{offset=Math.max(0,offset-30);void renderPanel();};
    panel.querySelector('#user-next').onclick=()=>{offset+=30;void renderPanel();};
  }
  const tripRows=items=>items.map(t=>`<tr><td>${esc(t.title)}</td><td>${esc((t.cities||[]).join('、')||'—')}</td><td>${t.status==='completed'?'用户标记完成':'计划中'}</td><td>v${t.version}</td><td>${time(t.updated_at)}</td></tr>`);
  async function renderPanel(){
    const own=++generation;status.textContent='正在加载…';
    try{
      if(tab==='overview'){
        panel.innerHTML=`<div class="metrics user-metrics">${[['历史行程',c.trips,'trips'],['CityWalk',c.citywalks,'citywalks'],['想去地点',c.wishes,'visits'],['收藏帖子',c.favorites,'visits?kind=favorites'],['用户标记到访',c.marked_visits,'visits?kind=marked'],['已有到访检测',c.presence_records,'visits?kind=presence'],['AI 会话',c.conversations,''],['未读消息',c.unread_messages,'messages']].map(([name,n,target])=>`<button class="metric" ${target?`data-target="${target}"`: 'disabled'}><span>${name}</span><strong>${n}</strong></button>`).join('')}</div>
          <div class="insight-grid"><article class="admin-card"><h3>账号偏好</h3>${Object.entries(u.preferences).map(([key,v])=>`<p>${esc(styles[key]||key)}：${esc(value(v))}</p>`).join('')||'<p>尚未设置旅行偏好</p>'}</article><article class="admin-card"><h3>近期情况</h3><p>近 7 天服务失败 ${c.recent_failures} 次</p><p>标记完成行程 ${c.marked_completed} 次</p><p class="muted">统计覆盖已保存数据；完成标记不代表实际到访。</p></article></div><h3 class="section-caption">最近更新的行程</h3>${table(['行程','城市','状态','版本','更新时间'],tripRows(v.recentTrips))}`;
        panel.querySelectorAll('[data-target]').forEach(b=>b.onclick=()=>navigate('users',id,b.dataset.target));
      }else{
        const result=await api('/api/admin/users/'+id+'/'+tab+'?'+new URLSearchParams({offset,...filters,...(tab==='visits'?{kind:visitKind}:{})}));
        if(!isCurrent()||own!==generation)return;
        if(tab==='trips')panel.innerHTML=table(['行程','城市','状态','版本','更新时间'],tripRows(result.items));
        if(tab==='citywalks')panel.innerHTML=table(['路线','城市','地点数','步行距离','核验','更新时间'],result.items.map(w=>`<tr><td>${esc(w.title)}</td><td>${esc(w.city||'—')}</td><td>${w.stop_count}</td><td>${(w.distance_m/1000).toFixed(2)} km</td><td>${w.verification==='verified'?'已核验':'未核验'}</td><td>${time(w.updated_at)}</td></tr>`));
        if(tab==='preferences'){
          panel.innerHTML=`<article class="admin-card"><h3>账号设置</h3>${Object.entries(result.profile).map(([k,v])=>`<p>${esc(styles[k]||k)}：${esc(value(v))}</p>`).join('')||'<p>暂无设置</p>'}</article><h3 class="section-caption">用户明确确认的记忆</h3>${table(['维度','内容','强度 / 置信度','状态','更新时间'],result.confirmed.map(m=>`<tr><td>${esc(styles[m.dimension])}</td><td>${esc(value(m.value))}</td><td>${Math.round(m.strength*100)}% / ${Math.round(m.confidence*100)}%</td><td>${m.expired?'已过期':'有效'}</td><td>${time(m.updated_at)}</td></tr>`))}<article class="admin-card"><h3>行为推断</h3><p>行为偏好评分尚未接入；不会把浏览行为当成用户已确认的偏好。</p></article>`;
        }
        if(tab==='messages')panel.innerHTML=table(['消息','送达时间','阅读状态'],result.items.map(m=>`<tr><td>${esc(m.title)}</td><td>${time(m.created_at)}</td><td>${m.read_at?'已读 · '+time(m.read_at):'未读'}</td></tr>`));
        if(tab==='visits'){
          panel.innerHTML=`<div class="filters"><label>记录<select id="visit-kind"><option value="wishes">想去地点</option><option value="marked">用户标记到访</option><option value="presence">已有到访检测</option><option value="favorites">收藏帖子</option></select></label></div>${table(['地点 / 内容','记录时间',visitKind==='presence'?'已记录停留':'到访日期'],result.items.map(p=>`<tr><td>${esc(p.name||'地点名称尚未解析')}<span class="table-secondary">${esc(p.place_id)}</span></td><td>${time(p.recorded_at)}</td><td>${visitKind==='presence'?Math.round(p.dwell_seconds/60)+' 分钟':p.visited_at?esc(String(p.visited_at).slice(0,10)):'—'}</td></tr>`))}<p class="table-note">想去、用户标记与到访检测分别统计。未采集连续 GPS 轨迹。</p>`;
          panel.querySelector('#visit-kind').value=visitKind;panel.querySelector('#visit-kind').onchange=e=>{visitKind=e.target.value;offset=0;void renderPanel();};
        }
        if(tab==='timeline'){
          panel.innerHTML=`<form class="filters" id="timeline-filter"><label>开始<input name="from" type="date" value="${esc(filters.from||'')}"></label><label>结束<input name="to" type="date" value="${esc(filters.to||'')}"></label><label>来源<select name="source"><option value="all">全部记录</option><option value="operation">软件操作</option><option value="business">历史业务记录</option><option value="product">业务事件</option></select></label><button>筛选</button></form>
            <ol class="user-timeline">${result.items.map(e=>`<li class="${e.status>=400?'failed':''}"><div class="timeline-meta"><time>${time(e.created_at)}</time><span class="badge">${e.source==='business'?'历史业务记录':e.source==='product'?'业务事件':'软件操作'}</span></div><h3>${esc(actions[e.action]||e.action)}</h3>${e.detail?.title?`<p>${esc(e.detail.title)}${e.detail.version?' · v'+e.detail.version:''}</p>`:''}<p>${e.status?`HTTP ${e.status} `:''}${e.duration_ms!==null?e.duration_ms+' ms':''}</p>${e.request_id?`<details><summary>关联请求</summary><code>${esc(e.request_id)}</code></details>`:''}</li>`).join('')||'<li class="empty">此时间范围暂无记录</li>'}</ol><p class="table-note">默认最近 7 天。业务记录来源于实际保存时间，不补造历史点击过程。</p>`;
          panel.querySelector('select[name=source]').value=filters.source||'all';panel.querySelector('#timeline-filter').onsubmit=e=>{e.preventDefault();filters=Object.fromEntries([...new FormData(e.target)].filter(([,v])=>v));offset=0;void renderPanel();};
        }
        if(tab!=='preferences')pager(result.hasMore);
      }
      if(isCurrent())status.textContent='';
    }catch(e){if(isCurrent()&&own===generation){panel.innerHTML='<div class="empty">暂时无法加载此项数据</div>';status.textContent=e.message;}}
  }
  await renderPanel();
}
