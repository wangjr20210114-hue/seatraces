/* 展示用户活跃、业务漏斗和趋势统计。 */

import {mountDailyArchives} from './admin-archives.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const table=(head,rows)=>`<div class="table-wrap"><table><thead><tr>${head.map(v=>`<th>${esc(v)}</th>`).join('')}</tr></thead><tbody>${rows.join('')||`<tr><td class="empty" colspan="${head.length}">所选期间暂无记录</td></tr>`}</tbody></table></div>`;
const date=v=>new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const metric=(name,n)=>`<article class="metric"><span>${name}</span><strong>${n}</strong></article>`;
const ratio=v=>v===null?'—':v+'%';
function trend(rows){
  const max=Math.max(1,...rows.map(r=>Math.max(r.active,r.trips,r.walks))),w=700,h=180,step=w/rows.length;
  return `<svg viewBox="0 0 720 220" role="img" aria-label="每日活跃与保存趋势；精确数值见下方表格" class="analytics-chart">
    ${[0,.5,1].map(n=>`<line x1="10" y1="${10+h*(1-n)}" x2="710" y2="${10+h*(1-n)}" stroke="#e2e8f0"/>`).join('')}
    ${rows.map((r,i)=>['active','trips','walks'].map((key,j)=>`<rect x="${10+i*step+j*step*.24}" y="${10+h*(1-r[key]/max)}" width="${Math.max(1,step*.21)}" height="${h*r[key]/max}" fill="${['#3675dd','#22a78e','#e6a03c'][j]}"><title>${r.day} ${key}: ${r[key]}</title></rect>`).join('')+(i===0||i===rows.length-1||i%Math.ceil(rows.length/6)===0?`<text x="${10+i*step}" y="212" font-size="10" fill="#65758b">${r.day.slice(5)}</text>`:'')).join('')}</svg>`;
}
export async function mountAdminAnalytics({content,status,api,can,isCurrent}){
  let tab='overview',filters={},generation=0,scopeQuery='';
  const labels={overview:'趋势',funnels:'转化漏斗',retention:'留存',segments:'用户分群',archives:'长期汇总',...(can('users.manage')?{scope:'统计范围'}:{})};
  content.innerHTML=`<div class="admin-tabs" role="tablist" aria-label="运营分析">${Object.entries(labels).map(([k,v])=>`<button role="tab" data-analytics="${k}" aria-selected="${k===tab}">${v}</button>`).join('')}</div><section id="analytics-panel"></section>`;
  const panel=content.querySelector('#analytics-panel');
  content.querySelectorAll('[data-analytics]').forEach(b=>b.onclick=()=>{tab=b.dataset.analytics;content.querySelectorAll('[data-analytics]').forEach(x=>x.setAttribute('aria-selected',x===b));void render();});
  async function render(){
    const own=++generation;status.textContent='正在计算…';
    try{
      if(tab==='archives'){await mountDailyArchives({content:panel,status,api,isCurrent:()=>isCurrent()&&own===generation});return;}
      if(tab==='scope'){
        const v=await api('/api/admin/analytics/scope?'+new URLSearchParams({q:scopeQuery}));if(!isCurrent()||own!==generation)return;
        panel.innerHTML=`<form id="scope-filter" class="filters"><label>账号 / 昵称<input name="q" maxlength="80" value="${esc(scopeQuery)}" placeholder="留空查看已排除账号"></label><button>查询</button></form>${table(['账号','昵称','统计范围','操作'],v.items.map(u=>`<tr><td>${esc(u.username)}</td><td>${esc(u.nickname)}</td><td>${u.staff?'后台人员 · 自动排除':u.analytics_excluded?'测试账号 · 已排除':'参与统计'}</td><td><button data-scope="${u.id}" ${u.staff?'disabled':''}>${u.analytics_excluded?'恢复统计':'标为测试账号'}</button></td></tr>`))}<p class="table-note">后台人员自动排除。测试标记只影响统计，不删除任何记录。${v.hasMore?'结果较多，请缩小关键词。':''}</p>`;
        panel.querySelector('form').onsubmit=e=>{e.preventDefault();scopeQuery=new FormData(e.target).get('q');void render();};
        panel.querySelectorAll('[data-scope]').forEach(b=>b.onclick=async()=>{
          const u=v.items.find(u=>u.id===b.dataset.scope);
          if(!confirm(`${u.analytics_excluded?'恢复':'排除'} ${u.username} 的运营统计？历史数据会按新范围重新计算。`))return;
          b.disabled=true;try{await api('/api/admin/users/'+u.id+'/analytics',{excluded:!u.analytics_excluded,confirmation:'change-analytics-scope'},'PATCH');await render();}catch(e){status.textContent=e.message;b.disabled=false;}
        });status.textContent='';return;
      }
      const v=await api('/api/admin/analytics/'+tab+'?'+new URLSearchParams(filters));if(!isCurrent()||own!==generation)return;
      filters.from=v.window.from;filters.to=v.window.to;
      panel.innerHTML=`<form id="analytics-filter" class="filters"><label>开始<input name="from" type="date" required value="${v.window.from}"></label><label>结束<input name="to" type="date" required value="${v.window.to}"></label>${tab==='funnels'?'<label>流程<select name="kind"><option value="journey">个性化行程</option><option value="citywalk">自建 CityWalk</option><option value="agent">AI 操作</option></select></label>':''}<button class="primary">查询</button></form><div class="coverage-note"><span class="badge ${v.coverage.partial?'paused':''}">${v.coverage.partial?'行为采集不覆盖全部所选日期':'行为采集期间'}</span> 自 ${date(v.coverage.startedAt)} 起采集 · 北京时间</div>`;
      if(tab==='overview'){
        panel.insertAdjacentHTML('beforeend',`<div class="metrics">${[['期间活跃用户',v.totals.active],['期间新用户',v.totals.registered],['保存行程',v.totals.trips],['保存 CityWalk',v.totals.walks]].map(([k,n])=>metric(k,n)).join('')}</div><article class="admin-card"><h3>每日趋势</h3><div class="chart-legend"><span>● 活跃用户</span><span>● 保存行程</span><span>● 保存 CityWalk</span></div>${trend(v.series)}</article>${table(['日期','活跃用户','新用户','保存行程','保存 CityWalk'],v.series.map(r=>`<tr><td>${r.day}</td><td>${r.active}</td><td>${r.registered}</td><td>${r.trips}</td><td>${r.walks}</td></tr>`))}<details class="metric-definitions"><summary>统计口径</summary>${Object.values(v.coverage.definitions).map(t=>`<p>${esc(t)}</p>`).join('')}<p>行为采集之前的空值表示无记录，不能用于判断当时实际活跃；保存数来自当前仍存在的业务记录。</p></details>`);
      }else if(tab==='funnels'){
        panel.querySelector('[name=kind]').value=v.kind;
        panel.insertAdjacentHTML('beforeend',`<article class="admin-card"><h3>${esc(v.name)} · 按${v.unit==='action'?'操作':'会话'}计数</h3><ol class="funnel-steps">${v.steps.map(s=>`<li><div><strong>${esc(s.label)}</strong><span>${s.count} · ${ratio(s.conversion)}</span></div><progress max="${Math.max(1,v.steps[0].count)}" value="${s.count}"></progress>${s.dropoff?`<p class="muted">较上一步未进入 ${s.dropoff}</p>`:''}</li>`).join('')}</ol><p>转化窗口 ${v.conversionWindowDays} 天 · 已结束观察 ${v.maturedFlows} · 仍在观察 ${v.observingFlows}</p></article><p class="table-note">按同一用户、同一流程、步骤先后计数。重复请求不累加；观察期内的未完成流程不能直接判定流失。</p>`);
      }else if(tab==='retention'){
        panel.insertAdjacentHTML('beforeend',table(['注册日期','注册用户','次日留存','第 7 天留存','第 30 天留存'],v.items.map(r=>`<tr><td>${r.day}</td><td>${r.registered}</td>${r.periods.map(p=>`<td>${p.status==='observing'?'观察中':p.status==='unavailable'?'采集未覆盖':`${ratio(p.rate)} <span class="table-secondary">${p.retained} / ${r.registered}</span>`}</td>`).join('')}</tr>`))+`<p class="table-note">注册当日为第 0 天；目标自然日结束后，计算该日有页面行为或业务事件的用户比例。目标日采集不完整时不计算。</p>`);
      }else{
        const groups=[['期末正式旅行用户','total'],['期间新用户','new_users'],['期间活跃','active'],['期间无行为记录','inactive'],['保存过行程','planners'],['保存过 CityWalk','walkers'],['AI 操作成功','agent_users']];
        panel.insertAdjacentHTML('beforeend',`<div class="metrics">${groups.map(([name,key])=>metric(name,v.counts[key])).join('')}</div><p class="table-note">分群可以重叠。“无行为记录”不等同流失；此页只显示汇总，不包含个人身份信息。</p>`);
      }
      panel.querySelector('#analytics-filter').onsubmit=e=>{e.preventDefault();filters=Object.fromEntries(new FormData(e.target));void render();};status.textContent='';
    }catch(e){if(isCurrent()&&own===generation)status.textContent=e.message;}
  }
  await render();
}
