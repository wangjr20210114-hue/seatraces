import {mountLogExports} from './admin-log-exports.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const columnNames={created_at:'时间',username:'用户',kind:'类型',action:'操作',status:'HTTP 状态',duration_ms:'耗时',request_id:'请求编号',resource_id:'对象编号'};
const defaultColumns=['created_at','username','kind','action','status','duration_ms'];
const filterKeys=['from','to','userId','kind','actor','action','outcome','minDuration','requestId','resourceId','sort','order'];
const kinds={navigation:'页面轨迹',request:'接口操作',admin:'管理审计',system:'系统错误'};
export function readLogLocation(hash){
  const params=new URLSearchParams(hash.split('?')[1]||'');
  const filters=Object.fromEntries(filterKeys.filter(k=>params.has(k)&&params.get(k)!=='').map(k=>[k,params.get(k)]));
  const columns=(params.get('columns')||'').split(',').filter((x,i,a)=>Object.hasOwn(columnNames,x)&&a.indexOf(x)===i);
  const raw=Number(params.get('offset')||0),offset=Number.isInteger(raw)&&raw>=0&&raw<=100000?raw:0;
  return {filters,columns:columns.length?columns:defaultColumns.slice(),offset};
}
export async function mountLogExplorer({content,status,api,isCurrent,can,details,navigate}){
  const state=readLogLocation(location.hash);let version=0,views=[],selected='',rows=[];
  const alive=n=>isCurrent()&&n===version;
  const writeLocation=()=>history.replaceState(history.state,'','#/events?'+new URLSearchParams({...state.filters,columns:state.columns.join(','),...(state.offset?{offset:state.offset}:{})}));
  const input=(key,label,type='text',length=120)=>`<label>${label}<input name="${key}" type="${type}" ${type==='text'?`maxlength="${length}"`:''} value="${esc(state.filters[key]||'')}" ${type==='number'?'min="0" max="2147483647"':''}></label>`;
  content.innerHTML=`<section class="admin-card log-workbench"><div class="log-toolbar"><strong>日志工作台</strong><div class="log-presets"><button data-preset="all">全部记录</button><button data-preset="failure">失败记录</button><button data-preset="slow">慢请求 ≥ 1 秒</button></div></div>
    <form id="log-filter" class="filters log-filters">${input('from','开始日期','date')}${input('to','结束日期','date')}${input('actor','账号 / 昵称','text',80)}${input('action','操作关键词')}
    <label>类型<select name="kind"><option value="">全部类型</option>${Object.entries(kinds).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label>
    <label>结果<select name="outcome"><option value="all">全部结果</option><option value="failure">失败（HTTP ≥ 400 / 系统错误）</option><option value="success">HTTP 成功（200–399）</option></select></label>
    ${input('minDuration','最短耗时（毫秒）','number')}${input('requestId','请求编号','text',36)}${input('resourceId','对象编号','text',200)}
    <label>排序<select name="sort"><option value="created_at">时间</option><option value="duration_ms">耗时</option></select></label><label>顺序<select name="order"><option value="desc">从高到低 / 从新到旧</option><option value="asc">从低到高 / 从旧到新</option></select></label>
    <div class="log-filter-actions"><button class="primary" type="submit">查询</button><button type="button" id="log-reset">重置</button></div></form>
    <div class="log-view-tools"><label>我的视图<select id="log-view"><option value="">当前筛选</option></select></label><button id="log-view-apply">应用视图</button>
    <details class="log-view-editor"><summary>保存 / 管理视图</summary><div><label>视图名称<input id="log-view-name" maxlength="50" placeholder="例如：行程故障排查"></label><button id="log-view-save">另存新视图</button><button id="log-view-update" disabled>更新所选视图</button><button id="log-view-delete" disabled>删除所选视图</button></div></details>
    <details class="log-column-settings"><summary>显示列</summary><div>${Object.entries(columnNames).map(([k,v])=>`<label><input type="checkbox" data-column="${k}" ${state.columns.includes(k)?'checked':''}>${v}</label>`).join('')}</div></details></div>
    <div id="log-view-status" role="status" aria-live="polite"></div></section>
    <div class="log-results" id="log-results" aria-live="polite"></div><div id="log-exports"></div>`;
  const $=s=>content.querySelector(s),form=$('#log-filter');
  function syncForm(){for(const key of filterKeys){const el=form.elements.namedItem(key);if(el)el.value=state.filters[key]??({sort:'created_at',order:'desc',outcome:'all'}[key]||'');}}
  function takeFilters(){state.filters={...(state.filters.userId?{userId:state.filters.userId}:{}),...Object.fromEntries([...new FormData(form)].filter(([,v])=>v!==''))};state.offset=0;}
  syncForm();
  function cell(row,key){
    const value=row[key];
    if(key==='created_at')return esc(new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}));
    if(key==='username')return row.user_id&&can('users.read')?`<button class="log-user-link" data-log-user="${esc(row.user_id)}">${esc(value||'已删除用户')}</button>`:esc(value||'系统');
    if(key==='kind')return esc(kinds[value]||value);
    if(key==='status')return value==null?'—':`<span class="badge ${value>=400?'paused':''}">${esc(value)}</span>`;
    if(key==='duration_ms')return value==null?'—':esc(value)+' ms';
    return `<span class="log-cell" title="${esc(value)}">${esc(value??'—')}</span>`;
  }
  async function load(){
    const n=++version;writeLocation();status.textContent='正在查询日志…';$('#log-results').setAttribute('aria-busy','true');
    try{
      const data=await api('/api/admin/events?'+new URLSearchParams({...state.filters,offset:state.offset}));if(!alive(n))return;rows=data.items;
      $('#log-results').innerHTML=`<div class="table-wrap"><table><thead><tr>${state.columns.map(k=>`<th>${columnNames[k]}</th>`).join('')}<th>详情</th></tr></thead><tbody>${rows.map(r=>`<tr>${state.columns.map(k=>`<td>${cell(r,k)}</td>`).join('')}<td><button data-log-event="${r.id}">查看</button></td></tr>`).join('')||`<tr><td colspan="${state.columns.length+1}" class="empty">没有符合条件的日志</td></tr>`}</tbody></table></div>
        <div class="pager"><button id="log-prev" ${state.offset?'':'disabled'}>上一页</button><span>第 ${Math.floor(state.offset/30)+1} 页 · 本页 ${rows.length} 条</span><button id="log-next" ${data.hasMore?'':'disabled'}>下一页</button></div>`;
      content.querySelectorAll('[data-log-event]').forEach(b=>b.onclick=()=>void details.event(b.dataset.logEvent));
      content.querySelectorAll('[data-log-user]').forEach(b=>b.onclick=()=>navigate('users',b.dataset.logUser,'timeline'));
      $('#log-prev').onclick=()=>{state.offset=Math.max(0,state.offset-30);void load();};$('#log-next').onclick=()=>{state.offset+=30;void load();};
      status.textContent='';
    }catch(e){if(alive(n)){$('#log-results').innerHTML='<div class="admin-card">查询失败，请调整条件或重试。</div>';status.textContent=e.message;}}
    finally{if(alive(n))$('#log-results').setAttribute('aria-busy','false');}
  }
  form.onsubmit=e=>{e.preventDefault();takeFilters();void load();};
  $('#log-reset').onclick=()=>{state.filters={};state.offset=0;selected='';$('#log-view').value='';syncForm();syncSelected();void load();};
  content.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{state.filters=b.dataset.preset==='failure'?{outcome:'failure'}:b.dataset.preset==='slow'?{minDuration:1000,sort:'duration_ms'}:{};state.offset=0;syncForm();void load();});
  content.querySelectorAll('[data-column]').forEach(b=>b.onchange=()=>{const columns=[...content.querySelectorAll('[data-column]:checked')].map(x=>x.dataset.column);if(!columns.length){b.checked=true;$('#log-view-status').textContent='至少保留一列';return;}state.columns=columns;void load();});
  function syncSelected(){const item=views.find(v=>v.id===selected);$('#log-view-update').disabled=!item;$('#log-view-delete').disabled=!item;$('#log-view-delete').textContent='删除所选视图';if(item)$('#log-view-name').value=item.name;}
  async function loadViews(){const data=await api('/api/admin/events/views');if(!isCurrent())return;views=data.items;$('#log-view').innerHTML='<option value="">当前筛选</option>'+views.map(v=>`<option value="${v.id}">${esc(v.name)}</option>`).join('');$('#log-view').value=selected;syncSelected();}
  $('#log-view').onchange=e=>{selected=e.target.value;syncSelected();};
  $('#log-view-apply').onclick=()=>{const view=views.find(v=>v.id===selected);if(!view)return;state.filters={...view.filters};state.columns=[...view.columns];state.offset=0;syncForm();content.querySelectorAll('[data-column]').forEach(b=>b.checked=state.columns.includes(b.dataset.column));void load();};
  async function saveView(update){const button=$(update?'#log-view-update':'#log-view-save');button.disabled=true;try{
    takeFilters();const old=update?views.find(v=>v.id===selected):null;if(update&&!old)return;
    const id=old?.id||crypto.randomUUID();const result=await api('/api/admin/events/views/'+id,{id,name:$('#log-view-name').value,filters:state.filters,columns:state.columns,...(old?{version:old.version}:{})},'PUT');if(!isCurrent())return;selected=result.id;await loadViews();$('#log-view-status').textContent='视图已保存';await load();
  }catch(e){if(isCurrent())$('#log-view-status').textContent=e.message;}finally{if(isCurrent()){button.disabled=false;syncSelected();}}}
  $('#log-view-save').onclick=()=>void saveView(false);$('#log-view-update').onclick=()=>void saveView(true);
  $('#log-view-delete').onclick=async()=>{const b=$('#log-view-delete'),view=views.find(v=>v.id===selected);if(!view)return;if(b.textContent!=='确认删除此视图'){b.textContent='确认删除此视图';return;}b.disabled=true;try{await api('/api/admin/events/views/'+view.id,{version:view.version,confirmation:'delete-view'},'DELETE');if(!isCurrent())return;selected='';await loadViews();$('#log-view-status').textContent='视图已删除，原始日志保留';}catch(e){if(isCurrent())$('#log-view-status').textContent=e.message;}finally{if(isCurrent())syncSelected();}};
  await Promise.all([load(),loadViews().catch(e=>{if(isCurrent())$('#log-view-status').textContent=e.message;}),
    can('events.export')?mountLogExports({host:$('#log-exports'),api,isCurrent,getFilters:()=>({...state.filters})}):Promise.resolve()]);
}
