export { mainlandEligible } from "../public/coordinates.js";
// A leg changes only at a transport transfer; street turns remain nested steps.
export const numberOrNull = v => v === '' || v == null || Array.isArray(v) || !Number.isFinite(Number(v)) || Number(v)<0 ? null : Number(v);
const duration = o => numberOrNull(o?.cost?.duration ?? o?.duration);
const minutes = seconds => seconds===null ? null : Math.ceil(seconds/60);
// V5 live responses may wrap the coordinate string in { polyline: "..." }.
const lineText = value => typeof value==='string' ? value : typeof value?.polyline==='string' ? value.polyline : '';
const rawLine = value => lineText(value).split(';').filter(Boolean).map(s=>s.split(',').map(Number)).filter(p=>p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90);
function step(s, convert) {
  return {instruction:s.instruction||s.road_name||s.road||'沿路线前行',distanceMeters:numberOrNull(s.step_distance??s.distance),durationSeconds:duration(s),polyline:convert(lineText(s.polyline)),mapPolyline:rawLine(s.polyline),action:s.navi?.action||null};
}
function walking(w, convert) {
  const steps=(w.steps||[]).map(s=>step(s,convert));
  return {mode:'walk',instruction:steps.map(s=>s.instruction).join('；')||'步行连接路段',
    durationSeconds:duration(w),minutes:minutes(duration(w)),distanceMeters:numberOrNull(w.distance),
    steps,polyline:steps.flatMap(s=>s.polyline),mapPolyline:steps.flatMap(s=>s.mapPolyline)};
}
export function finalizeAlternative(a) {
  a.segments=a.segments.map((s,i)=>({...s,id:`leg-${i+1}`,start:s.start||s.polyline[0]||null,end:s.end||s.polyline.at(-1)||null}));
  const vehicles=a.segments.filter(s=>!['walk'].includes(s.mode));
  a.transferCount=Math.max(0,vehicles.length-1);
  a.direct=vehicles.length===1;
  const walks=a.segments.filter(s=>s.mode==='walk');
  a.walkingMeters=walks.every(s=>s.distanceMeters!==null)?walks.reduce((n,s)=>n+s.distanceMeters,0):null;
  a.minutes=minutes(a.durationSeconds);
  a.distanceKm=a.distanceMeters===null?null:a.distanceMeters/1000;
  a.hasCompleteGeometry=a.segments.every(s=>s.polyline.length>=2&&(!s.steps?.length||s.steps.every(step=>step.polyline.length>=2)));
  return a;
}
export function transitAlternatives(transits, convert) {
  return (Array.isArray(transits)?transits:[]).map((t,i)=>{
    const legs=[];
    for(const s of t.segments||[]) {
      if(s.walking?.steps?.length || numberOrNull(s.walking?.distance)>0) legs.push(walking(s.walking,convert));
      const bus=s.bus?.buslines?.[0];
      if(bus) legs.push({mode:/地铁|轻轨|subway|metro/i.test((bus.type||'')+' '+bus.name)?'metro':'bus',
        instruction:`${bus.departure_stop?.name||'上车'} → ${bus.arrival_stop?.name||'下车'} · ${bus.name||'公共交通'}`,
        line:bus.name,boarding:bus.departure_stop?.name||null,alighting:bus.arrival_stop?.name||null,
        alternativeLines:(s.bus.buslines||[]).slice(1).map(b=>b.name),stopCount:numberOrNull(bus.via_num),
        durationSeconds:duration(bus),minutes:minutes(duration(bus)),distanceMeters:numberOrNull(bus.distance),steps:[],
        polyline:convert(lineText(bus.polyline)),mapPolyline:rawLine(bus.polyline)});
      if(s.railway?.id||s.railway?.name) {
        const r=s.railway,seconds=numberOrNull(r.time);
        legs.push({mode:'train',instruction:`${r.departure_stop?.name||'出发站'} → ${r.arrival_stop?.name||'到达站'} · ${r.name||'铁路'}`,
          boarding:r.departure_stop?.name,alighting:r.arrival_stop?.name,line:r.name,durationSeconds:seconds,
          minutes:minutes(seconds),distanceMeters:numberOrNull(r.distance),steps:[],polyline:convert(lineText(r.polyline)),mapPolyline:rawLine(r.polyline)});
      }
      if(s.taxi && (s.taxi.polyline || numberOrNull(s.taxi.distance)>0)) {
        const x=s.taxi,seconds=numberOrNull(x.drivetime);
        legs.push({mode:'taxi',instruction:`乘车：${x.startname||'上车点'} → ${x.endname||'下车点'}`,durationSeconds:seconds,
          minutes:minutes(seconds),distanceMeters:numberOrNull(x.distance),steps:[],polyline:convert(lineText(x.polyline)),mapPolyline:rawLine(x.polyline)});
      }
    }
    return finalizeAlternative({label:`公共交通方案 ${i+1}`,durationSeconds:duration(t),distanceMeters:numberOrNull(t.distance),segments:legs});
  }).filter(a=>a.segments.length);
}
export function pathAlternatives(paths, mode, convert) {
  const names={walking:'步行',driving:'驾车',cycling:'骑行'},modes={walking:'walk',driving:'drive',cycling:'cycle'};
  return (Array.isArray(paths)?paths:[]).map((p,i)=>{
    const steps=(p.steps||[]).map(s=>step(s,convert));
    return finalizeAlternative({label:`${names[mode]}方案 ${i+1}`,durationSeconds:duration(p),distanceMeters:numberOrNull(p.distance),
      segments:[{mode:modes[mode],instruction:steps.map(s=>s.instruction).join('；'),durationSeconds:duration(p),minutes:minutes(duration(p)),
        distanceMeters:numberOrNull(p.distance),steps,polyline:steps.flatMap(s=>s.polyline),mapPolyline:steps.flatMap(s=>s.mapPolyline)}]});
  }).filter(a=>a.segments[0].steps.length);
}
export function rankAlternatives(input,strategy) {
  const seen=new Set();
  const routes=input.filter(a=>{
    const key=JSON.stringify(a.segments.map(s=>[s.mode,s.line,s.boarding,s.alighting,s.polyline,s.instruction]));
    if(seen.has(key))return false;seen.add(key);return true;
  });
  const n=v=>v??Infinity;
  if(strategy==='fastest') routes.sort((a,b)=>n(a.durationSeconds)-n(b.durationSeconds));
  if(strategy==='fewTransfers') routes.sort((a,b)=>a.transferCount-b.transferCount||n(a.durationSeconds)-n(b.durationSeconds));
  if(strategy==='fewWalking') routes.sort((a,b)=>n(a.walkingMeters)-n(b.walkingMeters)||n(a.durationSeconds)-n(b.durationSeconds));
  return routes;
}
