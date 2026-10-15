import {createHash} from 'node:crypto';
import {query as dbQuery} from '../db.mjs';
import {route as providerRoute} from './routes.mjs';
import {routeMetres} from '../../public/citywalk-route.js';

export const walkLimits={warningMetres:10000,maximumMetres:15000};
export function walkDistanceState(value){
  if(!Number.isFinite(value)||value<0)return {verified:false,warning:false,blocked:false};
  return {verified:true,warning:value>walkLimits.warningMetres,blocked:value>=walkLimits.maximumMetres};
}
const keyOf=(a,b)=>createHash('sha256').update(JSON.stringify(['walk/1',...[a,b].map(p=>[p.id,p.lat,p.lng,p.country,p.coord_system])])).digest('hex');
export function createWalkingRouter({query=dbQuery,route=providerRoute,now=Date.now}={}){
  const inflight=new Map(),cooldown=new Map();
  async function leg(a,b){
    const key=keyOf(a,b);
    const cached=(await query('SELECT payload FROM citywalk_route_legs WHERE key=$1 AND expires_at>now()',[key])).rows[0];
    if(cached)return {...cached.payload,cached:true};
    if(inflight.has(key))return inflight.get(key);
    if((cooldown.get(key)||0)>now())return null;
    if(inflight.size>=32)return null;
    const work=(async()=>{
      try{
        const result=await route(a,b,'fastest','walking');
        if(result.status!=='live'||result.mapProvider!=='amap')return null;
        const alternatives=result.alternatives.filter(v=>Number.isFinite(v.distanceMeters)&&v.distanceMeters>=0&&v.segments?.some(s=>s.mapPolyline?.length>=2)).sort((a,b)=>a.distanceMeters-b.distanceMeters);
        if(!alternatives.length)return null;
        const best=alternatives[0],payload={fromId:a.id,toId:b.id,distanceM:best.distanceMeters,durationSeconds:best.durationSeconds,
          paths:best.segments.filter(s=>s.mapPolyline?.length>=2).map(s=>s.mapPolyline),checkedAt:result.checkedAt||new Date(now()).toISOString(),provider:'amap',coordinateSystem:'GCJ02'};
        await query(`INSERT INTO citywalk_route_legs(key,payload) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,expires_at=now()+interval '1 day'`,[key,JSON.stringify(payload)]);
        return payload;
      }catch{return null;}
    })().then(value=>{if(!value){cooldown.set(key,now()+60000);if(cooldown.size>1000)cooldown.delete(cooldown.keys().next().value);}return value;}).finally(()=>inflight.delete(key));
    inflight.set(key,work);return work;
  }
  async function verify(stops){
    if(stops.length<2)return {status:'preview',distanceM:null,estimatedDistanceM:0,legs:[],warning:false,blocked:false};
    const legs=[];
    for(let i=1;i<stops.length;i++){
      const item=await leg(stops[i-1],stops[i]);
      if(!item)return {status:'preview',distanceM:null,estimatedDistanceM:Math.round(routeMetres(stops)),legs:[],warning:false,blocked:false,reason:'walking_unavailable'};
      legs.push(item);
    }
    const distanceM=legs.reduce((sum,p)=>sum+p.distanceM,0),flags=walkDistanceState(distanceM);
    return {status:'verified',distanceM,estimatedDistanceM:null,durationSeconds:legs.every(l=>Number.isFinite(l.durationSeconds))?legs.reduce((n,l)=>n+l.durationSeconds,0):null,
      legs,...flags,provider:'amap',checkedAt:legs.map(l=>l.checkedAt).sort()[0],limits:walkLimits};
  }
  return {verify};
}
export const walkingRouter=createWalkingRouter();
