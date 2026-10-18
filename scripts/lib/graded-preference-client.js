// Self-contained offline page. No fetch, credentials, remote resources or scores.
(()=>{
 const study=JSON.parse(document.getElementById('study-data').textContent),$=id=>document.getElementById(id),storageKey='seatraces-graded-'+study.protocolId;
 const fields={read:'想继续阅读这篇内容吗？',save:'想收藏，留到以后参考吗？',adopt:'愿意把其中的路线或地点用于出行吗？'},labels={no:'不愿意',maybe:'可能愿意',yes:'愿意',unknown:'信息不足'};
 const shuffle=list=>{const a=[...list];for(let i=a.length-1;i>0;i--){const j=crypto.getRandomValues(new Uint32Array(1))[0]%(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;};
 let state;try{state=JSON.parse(localStorage.getItem(storageKey));}catch{}
 const complete=r=>r&&Object.keys(fields).every(k=>Object.hasOwn(labels,r.ratings?.[k]));
 const valid=s=>s&&s.protocolId===study.protocolId&&/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(s.reviewerId||'')&&Array.isArray(s.order)&&s.order.length===study.tasks.length&&new Set(s.order).size===study.tasks.length&&s.order.every(id=>study.tasks.some(t=>t.id===id))&&Number.isInteger(s.index)&&s.index>=0&&s.index<=s.order.length&&s.responses&&s.order.slice(0,s.index).every(id=>complete(s.responses[id]));
 if(!valid(state))state={protocolId:study.protocolId,reviewerId:crypto.randomUUID(),order:[...shuffle(study.tasks.slice(0,study.primaryCount).map(t=>t.id)),...shuffle(study.tasks.slice(study.primaryCount).map(t=>t.id))],responses:{},index:0};
 let shown=performance.now();
 const save=()=>{try{localStorage.setItem(storageKey,JSON.stringify(state));}catch{$('status').textContent='无法暂存进度，请保持页面打开，完成后下载。';}};
 function render(){
  $('intro').hidden=true;$('done').hidden=state.index<state.order.length;$('review').hidden=!$('done').hidden;if(!$('done').hidden)return;
  const task=study.tasks.find(t=>t.id===state.order[state.index]);
  $('count').textContent=`${state.index+1} / ${study.tasks.length}`;$('bar').style.width=((state.index+1)/study.tasks.length*100)+'%';
  for(const k of ['scenario','title','body','route'])$(k).textContent=task[k]||'';$('tags').textContent=(task.tags||[]).join(' · ');
  $('ratings').replaceChildren();
  for(const [field,label] of Object.entries(fields)){
   const group=document.createElement('fieldset'),legend=document.createElement('legend'),choices=document.createElement('div');legend.textContent=label;choices.className='choices';group.append(legend,choices);
   for(const [rating,text] of Object.entries(labels)){
    const b=document.createElement('button');b.type='button';b.textContent=text;b.dataset.dimension=field;b.dataset.value=rating;b.setAttribute('aria-pressed',String(state.responses[task.id]?.ratings?.[field]===rating));
    b.onclick=()=>{const r=state.responses[task.id]??={taskId:task.id,ratings:{},elapsedMs:0};r.ratings[field]=rating;r.elapsedMs=Math.min(86400000,r.elapsedMs+Math.max(0,performance.now()-shown));shown=performance.now();save();render();};choices.append(b);
   }$('ratings').append(group);
  }
  $('back').disabled=state.index===0;$('next').disabled=!complete(state.responses[task.id]);$('next').textContent=state.index===state.order.length-1?'完成':'下一篇';shown=performance.now();
 }
 $('start').onclick=render;
 $('back').onclick=()=>{if(state.index>0){state.index--;save();render();}};
 $('next').onclick=()=>{if(!complete(state.responses[state.order[state.index]]))return;state.index++;save();render();};
 $('revise').onclick=()=>{state.index=0;save();render();};
 $('download').onclick=()=>{
  if(!state.order.every(id=>complete(state.responses[id])))return;
  const value={protocolId:study.protocolId,reviewerId:state.reviewerId,responses:state.order.map(id=>state.responses[id])};
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='seatraces-graded-review-'+state.reviewerId+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  $('status').textContent='已发起下载，请将 JSON 文件交回负责人。';
 };
})();
