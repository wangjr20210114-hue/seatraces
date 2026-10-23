/* 绘制路线示意图并计算显示范围。 */

import {scenePoint} from './map-scene.js';
import {schematicConnections} from './route-curves.js';

export function routeMap(snapshot={}) {
 const stops=(snapshot.days||[]).flatMap(d=>(d.stops||[]).map(p=>{
  if(!Number.isFinite(p.lat)||!Number.isFinite(p.lng)||Math.abs(p.lat)>85||Math.abs(p.lng)>180)return null;
  return scenePoint({...p,crs:p.crs||p.coord_system});
 })).filter(Boolean);
 return {stops,connections:schematicConnections(stops)};
}

export function routeViewport(positions,size=480,padding=48) {
 if(!positions.length)throw Error('路线没有坐标');
 const merc=([lng,lat])=>[(lng+180)/360,(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2];
 const p=positions.map(merc),xs=p.map(x=>x[0]),ys=p.map(x=>x[1]);
 const lo=[Math.min(...xs),Math.min(...ys)],hi=[Math.max(...xs),Math.max(...ys)];
 const zoom=Math.max(1,Math.min(17,Math.floor(Math.log2((size-padding*2)/(512*Math.max(hi[0]-lo[0],hi[1]-lo[1],1e-7))))));
 return {zoom,location:[(lo[0]+hi[0])*180-180,Math.atan(Math.sinh(Math.PI*(1-lo[1]-hi[1])))*180/Math.PI]};
}
