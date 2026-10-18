const time=v=>v?new Date(v).toLocaleString('zh-CN'):'—';
export async function mountOfficialFacts({content,status,api,isCurrent,can=()=>false}){
 const [sources,reviews]=await Promise.all([api('/api/admin/places/fact-sources'),api('/api/admin/places/fact-reviews')]);if(!isCurrent())return;
 content.replaceChildren();const add=(parent,tag,value)=>{const e=document.createElement(tag);e.textContent=value;parent.append(e);return e;};
 add(content,'h3','官方资料更新与复核');
 const update=add(content,'button','更新近期使用的地点');update.disabled=!can('tasks.manage');
 update.onclick=async()=>{update.disabled=true;try{const r=await api('/api/admin/maintenance/tasks',{id:crypto.randomUUID(),kind:'place_refresh',confirmation:'run-task'});status.textContent='更新任务已提交：'+r.id;}catch(e){status.textContent=e.message;}finally{update.disabled=!can('tasks.manage');}};
 for(const s of sources.items){const row=add(content,'article','');row.className='admin-card';add(row,'h4',s.place_name+' · '+s.publisher);add(row,'p',`最近检查 ${time(s.checked_at)} · 下次复核 ${time(s.refresh_after)} · ${s.last_status} · 待审核 ${s.pending}`);const a=add(row,'a','打开官方页面 ↗');a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';}
 add(content,'h3','待人工复核');if(!reviews.items.length)add(content,'p','暂无待复核资料');
 for(const r of reviews.items){const card=add(content,'article','');card.className='admin-card';add(card,'h4',r.place_name+' · '+r.field);add(card,'p',typeof r.fact.value==='string'?r.fact.value:JSON.stringify(r.fact.value));add(card,'blockquote',r.fact.evidence.quote);
  add(card,'p','采集 '+time(r.fact.evidence.retrievedAt)+' · 复核期限 '+time(r.fact.evidence.reviewAfter));const details=add(card,'details','');add(details,'summary','核对官网正文');add(details,'p',r.source_text);
  const label=add(card,'label','');const check=document.createElement('input');check.type='checkbox';label.append(check,document.createTextNode('我已核对地点、完整语义、适用日期及原文'));
  for(const [decision,name]of [['accept','确认入库'],['reject','拒绝']]){const b=add(card,'button',name);b.disabled=!can('places.manage');b.onclick=async()=>{if(!check.checked){status.textContent='请先核对官方证据';return;}b.disabled=true;try{await api('/api/admin/places/fact-reviews/'+r.id,{version:r.version,decision,confirmation:'review-official-fact'});if(isCurrent()){card.remove();status.textContent='复核已记录';}}catch(e){status.textContent=e.message;b.disabled=false;}};}
 }
}
