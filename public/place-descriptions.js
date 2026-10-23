/* 按需加载地点介绍并更新页面内容。 */

export function observePlaceDescriptions(container,{sessionId,api}) {
 let dead=false,active=0;const queue=[],seen=new Set();
 async function pump(){
  while(!dead&&active<2&&queue.length){
   const element=queue.shift();if(!element.isConnected)continue;active++;
   const id=element.dataset.descriptionId;
   void api(`/api/journey/sessions/${encodeURIComponent(sessionId)}/places/${encodeURIComponent(id)}/description`,{}).then(r=>{
    if(dead||!element.isConnected||r.placeId!==id)return;
    element.querySelector('.scenic-brief').textContent=r.shortText;
    element.querySelector('.scenic-full').textContent=r.fullText;
    element.setAttribute('aria-label',r.fullText);
   }).catch(()=>{}).finally(()=>{active--;void pump();});
  }
 }
 const observer=new IntersectionObserver(entries=>{
  for(const entry of entries)if(entry.isIntersecting&&!seen.has(entry.target)){
   seen.add(entry.target);observer.unobserve(entry.target);queue.push(entry.target);
  }
  void pump();
 },{threshold:.2});
 container.querySelectorAll('[data-description-id]').forEach(el=>observer.observe(el));
 return()=>{dead=true;queue.length=0;observer.disconnect();};
}
