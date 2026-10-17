export async function mountTripFeedback({content,trip,api,isCurrent}){
 const section=document.createElement('section');section.className='trip-day trip-feedback';
 section.innerHTML=`<h3>这次安排合心意吗？</h3><form><label>评价<select name="rating" aria-label="行程评分" required><option value="">选一个感受</option><option value="5">非常喜欢</option><option value="4">比较喜欢</option><option value="3">一般</option><option value="2">不太合适</option><option value="1">不合适</option></select></label><label>评价对象<select name="experience"><option value="plan">行程安排</option>${trip.status==='completed'?'<option value="trip">旅行后的体验</option>':''}</select></label><label>节奏<select name="pace"><option value="">暂不评价</option><option value="good">刚刚好</option><option value="too_busy">太赶了</option><option value="too_slow">太松了</option></select></label><button class="primary">保存评价</button><button type="button" data-remove hidden>撤回评价</button><p role="status" aria-live="polite"></p></form>`;
 content.append(section);const form=section.querySelector('form'),status=section.querySelector('[role=status]'),remove=section.querySelector('[data-remove]'),url='/api/journey/trips/'+encodeURIComponent(trip.id)+'/feedback';
 try{const r=await api(url);if(!isCurrent())return;if(r.feedback){form.elements.rating.value=r.feedback.rating;form.elements.experience.value=r.feedback.experience;form.elements.pace.value=r.feedback.aspects.pace||'';remove.hidden=false;}}
 catch(e){if(isCurrent())status.textContent=e.message;}
 form.onsubmit=async e=>{e.preventDefault();const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
  try{const rating=Number(form.elements.rating.value),pace=form.elements.pace.value;await api(url,{rating,experience:form.elements.experience.value,aspects:{places:rating,...(pace?{pace}:{})}},'PUT');if(isCurrent()){status.textContent='评价已保存';remove.hidden=false;}}
  catch(e){if(isCurrent())status.textContent=e.message;}finally{buttons.forEach(b=>b.disabled=false);}
 };
 remove.onclick=async()=>{remove.disabled=true;try{await api(url,undefined,'DELETE');if(isCurrent()){form.reset();remove.hidden=true;status.textContent='已撤回';}}catch(e){if(isCurrent())status.textContent=e.message;}finally{remove.disabled=false;}};
}
