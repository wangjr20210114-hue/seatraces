'use strict';
let map,payload,overlays=[];
function paint(){
  if(!map||!payload)return;
  overlays.forEach(line=>line.setMap(null));overlays=[];
  const bounds=new google.maps.LatLngBounds();
  for(const [i,s] of payload.segments.entries()){
    // Draw individual source steps to avoid inventing a bridge across gaps.
    for(const line of s.steps?.length?s.steps.map(step=>step.polyline):[s.polyline]){
      if(!Array.isArray(line)||line.length<2)continue;
      if(line.some(p=>!Array.isArray(p)||!p.every(Number.isFinite)||Math.abs(p[0])>90||Math.abs(p[1])>180))continue;
      const points=line.map(([lat,lng])=>({lat,lng}));points.forEach(p=>bounds.extend(p));
      overlays.push(new google.maps.Polyline({map,path:points,strokeColor:i===payload.active?'#257654':'#8b9b90',strokeWeight:i===payload.active?7:4,strokeOpacity:.9}));
    }
  }
  if(overlays.length)map.fitBounds(bounds,35);
  document.querySelector('#status').textContent=overlays.length?'Google Maps · 深色为当前换乘路段':'Google Maps · 当前路段几何缺失，请查看文字指引。';
}
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==parent||event.data?.type!=='seatraces-route'||!Array.isArray(event.data.segments))return;
  payload=event.data;paint();
});
window.gm_authFailure=()=>{document.querySelector('#status').textContent='Google Maps 授权失败，请检查浏览器 Key、域名限制和计费状态。';};
(async()=>{
  try{
    const response=await fetch('/api/maps/google/config'),config=await response.json();
    if(!response.ok)throw Error(config.error||'地图配置读取失败');
    if(!config.enabled){document.querySelector('#status').textContent='Google Maps 地图显示待配置，需要独立的浏览器 Key。';return;}
    await new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      const timer=setTimeout(()=>reject(Error('Google Maps 加载超时，请检查网络。')),15000);
      window.seatracesGoogleReady=()=>{clearTimeout(timer);resolve();};
      script.src='https://maps.googleapis.com/maps/api/js?'+new URLSearchParams({key:config.jsKey,callback:'seatracesGoogleReady',loading:'async',v:'quarterly',language:'zh-CN'});
      script.onerror=()=>{clearTimeout(timer);reject(Error('Google Maps 脚本加载失败，请检查网络。'));};document.head.append(script);
    });
    map=new google.maps.Map(document.querySelector('#map'),{center:{lat:35.68,lng:139.75},zoom:12,mapTypeControl:false,streetViewControl:false,fullscreenControl:false});paint();
  }catch(error){document.querySelector('#status').textContent=error.message;}
})();
