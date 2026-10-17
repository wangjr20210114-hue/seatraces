import {esc,routeCover,mapCover} from './social-ui.js';
async function smallPhoto(file){
 if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>15*1024*1024)throw Error('请选择 15 MB 内的 JPG、PNG 或 WebP 图片');
 const bmp=await createImageBitmap(file);
 try{if(bmp.width*bmp.height>16000000)throw Error('图片过大，请使用 1600 万像素以内的照片');const scale=Math.min(1,1440/bmp.width,1440/bmp.height),canvas=document.createElement('canvas');canvas.width=Math.round(bmp.width*scale);canvas.height=Math.round(bmp.height*scale);canvas.getContext('2d').drawImage(bmp,0,0,canvas.width,canvas.height);const data=canvas.toDataURL('image/jpeg',.8);if(data.length>1800000)throw Error('图片较大，请选择较小的照片');return data;}finally{bmp.close();}
}
export async function mountComposer({route,content,setTitle,api,navigate,isCurrent,toast}){
 setTitle('写一篇旅行分享');let dead=false,timer,jobTimer,d,localRevision=0,savedRevision=0,chain=Promise.resolve(),uploading=false;
 const live=()=>!dead&&isCurrent(),$=s=>content.querySelector(s);
 const cleanup=()=>{dead=true;clearTimeout(timer);clearTimeout(jobTimer);if(d&&localRevision!==savedRevision)void save().catch(()=>{});};
 content.className='social-composer';content.innerHTML='<p role="status">正在打开草稿…</p>';
 try{
  if(route.id==='new'){
   content.innerHTML='<div class="composer-start"><h2>这一程，想分享什么？</h2><button class="primary" data-empty>直接写一篇 ✎</button><button class="walk-create" data-source="journey">带上历史行程 ↗</button><button class="walk-create" data-source="citywalk">带上 CityWalk 〰</button><div class="source-list"></div><p role="status"></p></div>';
   let creating=false;
   const create=async source=>{if(creating)return;creating=true;try{const r=await api('/api/social/drafts',{id:crypto.randomUUID(),...(source?{source}:{})});if(live())navigate('/compose/'+r.id+(source?'?write=1':''));}catch(e){if(live())$('[role=status]').textContent=e.message;}finally{creating=false;}};
   $('[data-empty]').onclick=()=>create();
   let sourceRevision=0;
   content.querySelectorAll('[data-source]').forEach(b=>b.onclick=async()=>{
    const revision=++sourceRevision,kind=b.dataset.source;let offset=0,loading=false;
    $('.source-list').replaceChildren();
    async function load(){if(loading)return;loading=true;b.disabled=true;
     try{const r=await api((kind==='journey'?'/api/trips?summary=1&':'/api/citywalks?')+'limit=21&offset='+offset);if(!live()||revision!==sourceRevision)return;
      $('.source-list [data-more]')?.remove();$('.source-list').insertAdjacentHTML('beforeend',r.slice(0,20).map(x=>`<button class="source-card" data-id="${esc(x.id)}">${mapCover(kind,x.id,x.title,x.updated_at||x.version)}<b>${esc(x.title)}</b><span>${esc(kind==='citywalk'?x.city?.name||'CityWalk':'历史行程')} ↗</span></button>`).join(''));
      offset+=Math.min(r.length,20);if(r.length>20)$('.source-list').insertAdjacentHTML('beforeend','<button class="walk-create" data-more>更多路线 ↓</button>');if(!offset)$('.source-list').textContent='还没有保存的路线';$('[role=status]').textContent='';
     }catch(e){if(live()&&revision===sourceRevision)$('[role=status]').textContent=e.message;}finally{loading=false;b.disabled=false;}
    }
    $('.source-list').onclick=e=>{const p=e.target.closest('[data-id]');if(p)void create({kind,id:p.dataset.id});else if(e.target.closest('[data-more]'))void load();};await load();
   });
   return cleanup;
  }
  d=await api('/api/social/drafts/'+encodeURIComponent(route.id));if(!live())return cleanup;
  if(d.published_post_id){navigate('/post/'+d.published_post_id);return cleanup;}
  content.innerHTML=`<div class="composer-photos"></div><label class="photo-add">＋ 添加照片<input type="file" accept="image/jpeg,image/png,image/webp" multiple></label><label class="sr-only" for="post-title">标题</label><input id="post-title" maxlength="100" placeholder="给这一程起个标题" value="${esc(d.title)}"><label class="sr-only" for="post-body">正文</label><textarea id="post-body" maxlength="4000" rows="9" placeholder="写下你的路线、心情或出发期待…">${esc(d.body)}</textarea><input id="post-tags" maxlength="160" aria-label="话题，用逗号分隔" placeholder="# 话题，用逗号分隔" value="${esc(d.tags.join('，'))}">${d.source_id?`<details class="composer-route"><summary>已带上${d.source_kind==='citywalk'?' CityWalk':'行程'} ▾</summary>${(d.source_id?mapCover('draft',d.id,d.title,d.version):routeCover(d.snapshot,d.title))}</details><div class="composer-ai"><select aria-label="文案语气"><option value="lively">轻快种草</option><option value="concise">简短分享</option><option value="guide">实用攻略</option></select><button class="walk-create" data-ai>✦ AI 整理文案</button></div><section class="ai-suggestion" hidden></section>`:''}<p role="status" aria-live="polite">草稿已保存</p><footer class="composer-footer"><button class="walk-create" data-save>保存草稿</button><button class="primary" data-publish>发布 ↗</button></footer>`;
  function photos(){const box=$('.composer-photos');box.innerHTML=d.media_ids.length?d.media_ids.map((id,i)=>`<div><img src="/api/social/media/${esc(id)}" alt="照片 ${i+1}"><button data-remove="${esc(id)}" aria-label="移除照片 ${i+1}">×</button>${i?`<button class="photo-left" data-left="${i}" aria-label="照片 ${i+1} 前移">←</button>`:''}</div>`).join(''):(d.source_id?mapCover('draft',d.id,d.title,d.version):routeCover(d.snapshot,d.title));}
  function changed(){localRevision++;clearTimeout(timer);$('[role=status]').textContent='正在保存…';timer=setTimeout(()=>void save().catch(report),700);}
  function report(e){if(live())$('[role=status]').textContent=e.message;}
  // A single save queue preserves order, and never replaces text with a late response.
  save=()=>{clearTimeout(timer);const revision=localRevision;
   const fields={title:$('#post-title').value,body:$('#post-body').value,tags:$('#post-tags').value.split(/[，,]/).map(s=>s.trim().replace(/^#/,'' )).filter(Boolean),mediaIds:[...d.media_ids]};
   chain=chain.catch(()=>{}).then(async()=>{if(revision===savedRevision)return;const r=await api('/api/social/drafts/'+d.id,{...fields,version:d.version},'PUT');d.version=r.version;savedRevision=revision;if(live()&&savedRevision===localRevision)$('[role=status]').textContent='草稿已保存';});return chain;};
  photos();for(const input of content.querySelectorAll('#post-title,#post-body,#post-tags'))input.oninput=changed;
  $('.composer-photos').onclick=e=>{const remove=e.target.closest('[data-remove]'),left=e.target.closest('[data-left]');if(remove)d.media_ids=d.media_ids.filter(id=>id!==remove.dataset.remove);else if(left){const i=Number(left.dataset.left);[d.media_ids[i-1],d.media_ids[i]]=[d.media_ids[i],d.media_ids[i-1]];}else return;photos();changed();};
  $('input[type=file]').onchange=async e=>{if(uploading)return;const files=[...e.target.files];if(files.length+d.media_ids.length>9){report(Error('最多选择 9 张照片'));e.target.value='';return;}uploading=true;$('[data-publish]').disabled=true;
   try{for(const file of files){$('[role=status]').textContent='正在整理照片…';const image=await smallPhoto(file),r=await api('/api/social/drafts/'+d.id+'/media',{image});if(!live())return;d.media_ids.push(r.id);photos();changed();}await save();}catch(e){report(e);}finally{uploading=false;e.target.value='';if(live())$('[data-publish]').disabled=false;}};
  $('[data-save]').onclick=()=>save().then(()=>toast('草稿已保存')).catch(report);
  $('[data-publish]').onclick=async e=>{if(uploading)return;const b=e.currentTarget;b.disabled=true;try{await save();const r=await api('/api/social/drafts/'+d.id+'/publish',{version:d.version});if(live()){savedRevision=localRevision;toast('已发布');navigate('/post/'+r.id);}}catch(e){report(e);}finally{b.disabled=false;}};
  if($('[data-ai]'))$('[data-ai]').onclick=async e=>{
   const button=e.currentTarget;button.disabled=true;
   try{await save();const version=d.version,revision=localRevision;const j=await api('/api/social/drafts/'+d.id+'/generate',{id:e.automatic?d.id:crypto.randomUUID(),version,tone:$('.composer-ai select').value});
    const poll=async()=>{if(!live())return;try{const r=await api('/api/social/writing/'+j.id);if(!live())return;if(r.state==='running'){button.textContent='正在整理…';jobTimer=setTimeout(poll,1200);return;}if(r.state==='failed')throw Error(r.error);
     const box=$('.ai-suggestion');box.hidden=false;box.innerHTML=`<b>${esc(r.result.title)}</b><p>${esc(r.result.body)}</p><button class="primary" data-apply>采用这份草稿</button><button class="walk-create" data-dismiss>收起</button>`;
     $('[data-apply]').onclick=()=>{if(d.version!==version||localRevision!==revision){report(Error('你已经改过内容，请重新生成，避免覆盖修改'));return;}$('#post-title').value=r.result.title;$('#post-body').value=r.result.body;$('#post-tags').value=r.result.tags.join('，');box.hidden=true;changed();};$('[data-dismiss]').onclick=()=>box.hidden=true;
    }catch(e){report(e);}button.disabled=false;button.textContent='✦ AI 整理文案';};void poll();
   }catch(e){report(e);button.disabled=false;}
  };
  if(route.params?.write==='1'&&d.version===1&&!d.body&&$('[data-ai]'))void $('[data-ai]').onclick({currentTarget:$('[data-ai]'),automatic:true});
 }catch(e){if(live())content.textContent=e.message;}
 return cleanup;
 // Replaced after loading the editor. Cleanup may run while requests finish.
 function save(){return Promise.resolve();}
}
