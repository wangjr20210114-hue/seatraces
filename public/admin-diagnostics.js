/* 展示服务诊断结果和健康状态。 */

export async function mountDiagnostics({content,status,api,isCurrent,initial}){
 const add=(p,t,v)=>{const e=document.createElement(t);e.textContent=v;p.append(e);return e;};
 const area=add(content,'section','');let offset=0;
 async function list(data){
  const r=data||await api('/api/admin/traces?offset='+offset);if(!isCurrent())return;area.replaceChildren();
  add(area,'h3','请求链路');add(area,'p',`保留 ${r.retentionDays} 天 · 待写 ${r.health.queued} · 丢弃 ${r.health.dropped} · 写入失败 ${r.health.failed}`);
  const form=add(area,'form','');form.className='filters';const input=add(form,'input','');input.placeholder='请求编号';input.maxLength=36;input.required=true;
  const search=add(form,'button','查询');search.type='submit';form.onsubmit=async e=>{e.preventDefault();try{const v=await api('/api/admin/traces?requestId='+encodeURIComponent(input.value.trim()));if(isCurrent())await list(v);}catch(e){status.textContent=e.message;}};
  const table=add(area,'table','');const head=add(table,'tr','');for(const name of ['时间','请求','状态','耗时','操作'])add(head,'th',name);
  for(const item of r.items){const row=add(table,'tr','');for(const value of [new Date(item.started_at).toLocaleString('zh-CN'),item.method+' '+item.route,item.status,item.duration_ms+' ms'])add(row,'td',value);
   const cell=add(row,'td',''),open=add(cell,'button','查看链路');open.onclick=async()=>{try{const v=await api('/api/admin/traces/'+item.request_id);if(!isCurrent())return;area.replaceChildren();const back=add(area,'button','← 返回链路');back.onclick=()=>void list();
    add(area,'h3',v.method+' '+v.route);add(area,'p',`请求编号 ${v.request_id} · ${v.duration_ms} ms · 状态 ${v.status}`);
    const m=v.payload.memory;add(area,'p',`进程 RSS ${Math.round(m.rssStart/1048576)} → ${Math.round(m.rssEnd/1048576)} MB；采样最大值 ${Math.round(m.maxSampledRss/1048576)} MB`);
    add(area,'p','内存为共享进程采样，不能归因于单个请求分配量。');add(area,'p',`省略路段 ${v.payload.droppedSpans} · 尚未完成 ${v.payload.incompleteSpans}`);
    const t=add(area,'table',''),h=add(t,'tr','');for(const n of ['组件','操作','开始偏移','耗时','结果'])add(h,'th',n);
    for(const s of [...v.payload.spans].sort((a,b)=>a.startOffsetMs-b.startOffsetMs)){const tr=add(t,'tr','');for(const val of [s.kind,s.name+(s.attributes.provider?' · '+s.attributes.provider:''),s.startOffsetMs+' ms',s.durationMs+' ms',s.error?'失败 '+s.errorStatus:'成功'])add(tr,'td',val);}
   }catch(e){status.textContent=e.message;}};
  }
  for(const [label,delta,disabled]of [['上一页',-30,offset===0],['下一页',30,!r.hasMore]]){const b=add(area,'button',label);b.disabled=disabled;b.onclick=()=>{offset+=delta;void list();};}
 }
 await list(initial);
 try{const mail=await api('/api/admin/mail/status');if(!isCurrent())return;const box=add(content,'article','');box.className='admin-card';add(box,'h3','邮件投递');add(box,'p',mail.configuration.enabled?'配置齐全，实际投递请单独验收':'尚未配置：'+mail.configuration.missing.join('、'));
  for(const c of mail.counts)add(box,'p',c.state+' · '+c.count);
 }catch(e){if(isCurrent())status.textContent=e.message;}
}
