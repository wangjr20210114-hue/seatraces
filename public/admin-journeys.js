const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
const table=(heads,rows)=>`<div class="table-wrap"><table><thead><tr>${heads.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')||`<tr><td colspan="${heads.length}" class="empty">暂无记录</td></tr>`}</tbody></table></div>`;
const stops=items=>table(['顺序','地点','分类','到达 / 离开','游玩 / 前段交通','锁定'],items.map((s,i)=>`<tr><td>${i+1}</td><td>${esc(s.name||s.id||'未命名')}</td><td>${esc(s.category||'—')}</td><td>${esc(s.arrive||'—')} / ${esc(s.leave||'—')}</td><td>${s.durationMin??'—'} / ${s.travelMin??'—'} 分钟</td><td>${s.locked?'是':'否'}</td></tr>`));
export async function mountAdminJourneys({content,status,api,id,tab,isCurrent,navigate}){
  let seq=0,offset=0,filters={kind:tab==='citywalk'?'citywalk':'trip',state:'all'},version;
  const breadcrumbs=(userId)=>{content.querySelector('#back-journeys').onclick=()=>navigate('journeys');if(userId)content.querySelector('#journey-user').onclick=()=>navigate('users',userId);};
  async function detail(){
    const own=++seq;status.textContent='正在加载…';
    try{
      const walk=tab==='citywalk',v=await api('/api/admin/journeys/'+(walk?'citywalks/':'trips/')+id+(!walk&&version?'?version='+version:''));if(!isCurrent()||seq!==own)return;
      const t=walk?v:v.trip;
      content.innerHTML=`<div class="user-breadcrumb"><button id="back-journeys">← 旅行与路线</button><button id="journey-user">${esc(t.username)} · 用户全景</button></div><article class="admin-card"><h2>${esc(t.title)}</h2><p>${walk?esc(v.city||'—')+' · '+(v.distanceM/1000).toFixed(2)+' km · '+(v.verification==='verified'?'实际步行已核验':'保存距离未核验'):esc(v.request.cities.join(' → '))+' · '+esc(v.request.start||'—')+' 至 '+esc(v.request.end||'—')+' · '+(t.status==='completed'?'用户标记完成':'计划中')}</p><p class="muted">更新 ${time(t.updatedAt)} · 当前 v${walk?v.version:t.currentVersion}</p></article>`;
      breadcrumbs(t.userId);
      if(walk){content.insertAdjacentHTML('beforeend',`<h3>已保存的地点顺序</h3>${stops(v.stops)}<p class="table-note">当前仅保存路线最新版本；没有历史快照时不生成版本对比。</p>`);}
      else{
        const opts=selected=>v.versions.map(x=>`<option value="${x.version}" ${x.version===selected?'selected':''}>v${x.version} · ${time(x.created_at)}</option>`).join('');
        content.insertAdjacentHTML('beforeend',`<form class="filters" id="version-form"><label>查看版本<select name="version">${opts(v.selectedVersion)}</select></label><button>查看</button></form><p class="table-note">${esc(v.snapshotScope)}</p><section>${v.plan.days.map((d,i)=>`<article class="admin-card"><h3>Day ${i+1} · ${esc(d.city||'—')} · ${esc(d.date||'—')}</h3>${stops(d.stops)}${d.truncated?'<p>地点过多，仅显示前 100 项</p>':''}</article>`).join('')||'<p class="empty">此版本没有每日行程</p>'}</section><h3>已选择吃住</h3>${table(['类型','地点','使用日','选择时间'],v.plan.services.map(s=>`<tr><td>${esc(s.kind)}</td><td>${esc(s.place.name||'—')}</td><td>${s.days.map(d=>'Day '+(d+1)).join('、')}</td><td>${time(s.selectedAt)}</td></tr>`))}<article class="admin-card"><h3>对比已保存版本</h3><form id="compare-form" class="filters"><label>原版本<select name="fromVersion">${opts(v.versions.at(-1)?.version)}</select></label><label>新版本<select name="toVersion">${opts(v.selectedVersion)}</select></label><button>对比</button></form><div id="comparison"></div></article>`);
        content.querySelector('#version-form').onsubmit=e=>{e.preventDefault();version=Number(new FormData(e.target).get('version'));void detail();};
        content.querySelector('#compare-form').onsubmit=async e=>{
          e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;
          try{const d=await api('/api/admin/journeys/trips/'+id+'/compare?'+new URLSearchParams(new FormData(e.target)));if(!isCurrent()||seq!==own)return;
            content.querySelector('#comparison').innerHTML=`<p>v${d.fromVersion} → v${d.toVersion}</p>`+table(['日期','新增','移除','位置变化','时间 / 锁定变化'],d.days.map(x=>`<tr><td>Day ${x.index+1}<span class="table-secondary">${esc(x.beforeDate||'—')} → ${esc(x.afterDate||'—')}</span></td><td>${esc(x.added.map(s=>s.name||s.id).join('、')||'—')}</td><td>${esc(x.removed.map(s=>s.name||s.id).join('、')||'—')}</td><td>${esc(x.reordered.map(s=>`${s.name||s.id} ${s.from}→${s.to}`).join('、')||'—')}</td><td>${esc(x.changed.map(s=>s.name||s.id).join('、')||'—')}</td></tr>`))+`<p>吃住选择变化 ${d.services.length} 项</p>`;
          }catch(err){status.textContent=err.message;}finally{button.disabled=false;}
        };
      }
      status.textContent='';
    }catch(e){if(isCurrent()&&seq===own)status.textContent=e.message;}
  }
  async function list(){
    const own=++seq;status.textContent='正在加载…';
    try{
      const v=await api('/api/admin/journeys?'+new URLSearchParams({...filters,offset}));if(!isCurrent()||seq!==own)return;
      content.innerHTML=`<form class="filters" id="journey-filter"><label>类型<select name="kind"><option value="trip">行程</option><option value="citywalk">CityWalk</option></select></label><label>路线 / 账号<input name="q" maxlength="80" value="${esc(filters.q||'')}"></label><label>更新起始<input type="date" name="from" value="${esc(filters.from||'')}"></label><label>更新截止<input type="date" name="to" value="${esc(filters.to||'')}"></label><button>查询</button></form>`+table(['标题','用户','城市','状态 / 距离','版本','更新时间','操作'],v.items.map(t=>`<tr><td>${esc(t.title)}</td><td>${esc(t.username)}</td><td>${esc(v.kind==='trip'?t.cities.join('、'):t.city||'—')}</td><td>${v.kind==='trip'?(t.status==='completed'?'用户标记完成':'计划中'):(t.distance_m/1000).toFixed(2)+' km · '+(t.verification==='verified'?'已核验':'未核验')}</td><td>v${t.version}</td><td>${time(t.updated_at)}</td><td><button data-journey="${t.id}">查看路线</button></td></tr>`))+`<p class="table-note">默认显示最近 7 天更新；日期范围最多 31 天。用户标记完成不代表实际到访。</p><div class="pager"><button id="journey-prev" ${offset?'':'disabled'}>上一页</button><span>第 ${offset/30+1} 页</span><button id="journey-next" ${v.hasMore?'':'disabled'}>下一页</button></div>`;
      content.querySelector('[name=kind]').value=filters.kind;
      content.querySelector('#journey-filter').onsubmit=e=>{e.preventDefault();filters={state:'all',...Object.fromEntries([...new FormData(e.target)].filter(([,v])=>v))};offset=0;void list();};
      content.querySelectorAll('[data-journey]').forEach(b=>b.onclick=()=>navigate('journeys',b.dataset.journey,v.kind));
      content.querySelector('#journey-prev').onclick=()=>{offset=Math.max(0,offset-30);void list();};content.querySelector('#journey-next').onclick=()=>{offset+=30;void list();};status.textContent='';
    }catch(e){if(isCurrent()&&seq===own)status.textContent=e.message;}
  }
  await(id?detail():list());
}
