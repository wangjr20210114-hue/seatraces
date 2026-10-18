const reasonNames={explicitly_retained:'按你的要求保留',nearby_less_walking:'距离近，少走路',cultural_interest_and_depth:'人文主题与深度',popularity_and_coverage:'经典与覆盖',closed:'当日不开放',opening_window:'开放时段不合适',time_budget:'时间不够',walking_allowance:'超过步行额度',current_exclusion:'本次排除',already_scheduled_elsewhere:'已在其他日期安排',strategy_or_capacity:'方案取舍'};
export function mountPlanningAlternatives({element,trip,day,api,onSaved}){
 const area=document.createElement('section');area.className='plan-alternatives';element.append(area);
 const open=document.createElement('button');open.className='inline-action';open.textContent='比较方案 ⇄';
 const result=document.createElement('div');result.className='alternative-cards';const status=document.createElement('p');status.setAttribute('role','status');area.append(open,status,result);
 const button=(label,action)=>{const b=document.createElement('button');b.type='button';b.className='inline-action';b.textContent=label;b.onclick=async()=>{b.disabled=true;try{await action(b);}catch(e){status.textContent=e.message;}finally{b.disabled=false;}};return b;};
 const text=(parent,tag,value)=>{const n=document.createElement(tag);n.textContent=value;parent.append(n);return n;};
 function paint(item){
  const card=document.createElement('article');card.className='alternative-card';text(card,'h3',item.name);
  const metrics=text(card,'p','');const route=text(card,'p',item.stops.map(p=>p.name).join(' → '));route.className='alternative-route';
  function measure(v){metrics.textContent=`点间步行 ${(v.metrics.walkingMeters/1000).toFixed(1)} km · 交通 ${v.metrics.travelMinutes} 分 · 游览 ${v.metrics.visitMinutes} 分 · ${v.metrics.finishAt} 结束${v.verification==='verified'?' · 路线已核验':' · 待路线核验'}`;}
  measure(item);const details=document.createElement('details');text(details,'summary','为什么这样安排？');
  for(const e of item.explanations||[])text(details,'p',e.name+' · '+(reasonNames[e.reason]||'按本次约束'));
  for(const e of (item.excluded||[]).slice(0,12))text(details,'p',e.name+' · '+(reasonNames[e.reason]||'暂不安排'));card.append(details);
  const save=button('确认采用',async()=>{const t=await api('/api/trips/'+trip.id,{version:trip.version,operation:{type:'apply_preview',day,previewId:item.id}},'PATCH');onSaved(t);});save.disabled=true;
  const verify=button('核验实际路线',async()=>{status.textContent='正在核验路线…';const v=await api(`/api/journey/trips/${trip.id}/alternatives/${item.id}/verify`,{version:trip.version});measure(v);save.disabled=v.verification!=='verified';status.textContent=v.verification==='verified'?'路线可用，请确认是否采用':(v.warnings||[]).join('；')||'暂不可核验';});
  card.append(verify,save);result.append(card);
 }
 open.onclick=async()=>{open.disabled=true;status.textContent='正在比较方案…';result.replaceChildren();try{const r=await api(`/api/journey/trips/${trip.id}/alternatives`,{version:trip.version,day});if(!area.isConnected)return;r.items.forEach(paint);status.textContent=r.items.length?'':r.unmet.join('；');}catch(e){status.textContent=e.message;}finally{open.disabled=false;}};
 if(trip.version>1)area.append(button('撤销上次修改 ↶',async()=>{
  const versions=await api(`/api/trips/${trip.id}/versions`),previous=versions.find(v=>v.version<trip.version);
  if(!previous)throw Error('没有可恢复的版本');const t=await api('/api/trips/'+trip.id,{version:trip.version,restoreVersion:previous.version},'PATCH');onSaved(t);
 }));
}
