import { icon } from './ui-icons.js';
import {mainlandEligible,toGcj} from './coordinates.js';
import {schematicConnections} from './route-curves.js';
import {servicePlaceUrl} from './service-place-link.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function renderClassicWalk({route,content,setTitle,api,isCurrent}){
  setTitle('经典 CityWalk');content.innerHTML='<p class="page-status">正在展开路线…</p>';let removed=false,frame;
  const current=()=>!removed&&isCurrent();
  let scene;
  function paint(){if(current()&&scene)frame?.contentWindow?.postMessage(scene,location.origin);}
  function ready(e){if(e.origin===location.origin&&e.source===frame?.contentWindow&&e.data?.type==='seatraces-map-ready')paint();}
  window.addEventListener('message',ready);
  try{
    const w=await api('/api/citywalk/classics/'+encodeURIComponent(route.id.slice(8)));if(!current())return()=>{removed=true;window.removeEventListener('message',ready);};
    const valid=w.route.status==='verified',stops=w.stops.map(p=>({...p,position:mainlandEligible(p)?toGcj(p).split(',').map(Number):[p.lng,p.lat]}));
    setTitle(w.title);
    content.innerHTML=`<article class="classic-route-page"><div class="classic-route-heading"><span class="classic-city">${esc(w.city.name)}</span><h2>${esc(w.title)}</h2><b>${valid?'步行 '+(w.route.distanceM/1000).toFixed(2)+' 公里':'路线预览'}</b></div><div class="walk-preview classic-map"><iframe id="classic-map" title="经典 CityWalk 路线地图" src="/amap-view.html?mode=home"></iframe></div><ol class="classic-stops">${w.stops.map(p=>`<li><span>${esc(p.name)}</span><a href="${esc(servicePlaceUrl(p))}" target="_blank" rel="noopener">高德查看 ${icon('external')}</a></li>`).join('')}</ol></article>`;
    frame=content.querySelector('#classic-map');
    scene={type:'seatraces-route',kind:'citywalk',contextKey:'classic-'+w.id,lockView:true,view:'day',fitKey:'classic-'+w.id+'-'+w.version,viewPadding:[55,45,45,45],stops,
      connections:valid?w.route.legs.flatMap(l=>l.paths.map(path=>({path}))):schematicConnections(stops),cities:[],cityConnections:[],segments:[]};paint();
  }catch(e){if(current())content.textContent=e.message;}
  return()=>{removed=true;window.removeEventListener('message',ready);};
}
