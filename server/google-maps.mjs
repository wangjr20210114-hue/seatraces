/* 整理 Google 地点和路线请求，转换返回结果。 */

import { numberOrNull, finalizeAlternative, rankAlternatives } from './route-model.mjs';
import { departureInstant, placeTimeZone } from '../public/travel-time.js';

export const GOOGLE_ROUTE_MASK=[
  'routes.duration','routes.distanceMeters','routes.description','routes.warnings',
  'routes.legs.steps.travelMode','routes.legs.steps.distanceMeters','routes.legs.steps.staticDuration',
  'routes.legs.steps.polyline','routes.legs.steps.navigationInstruction',
  'routes.legs.steps.startLocation','routes.legs.steps.endLocation','routes.legs.steps.transitDetails'
].join(',');
export const GOOGLE_PLACE_MASK='places.id,places.displayName,places.formattedAddress,places.location,places.types,places.googleMapsUri,places.attributions';
const modes={walking:'WALK',driving:'DRIVE',cycling:'BICYCLE',transit:'TRANSIT'};
const localModes={WALK:'walk',DRIVE:'drive',BICYCLE:'cycle'};
const vehicleModes={SUBWAY:'metro',METRO_RAIL:'metro',TRAM:'tram',LIGHT_RAIL:'tram',RAIL:'train',COMMUTER_TRAIN:'train',HIGH_SPEED_TRAIN:'train',HEAVY_RAIL:'train',LONG_DISTANCE_TRAIN:'train',MONORAIL:'train',BUS:'bus',INTERCITY_BUS:'bus',TROLLEYBUS:'bus',SHARE_TAXI:'taxi',FERRY:'ferry',CABLE_CAR:'cable',GONDOLA_LIFT:'cable',FUNICULAR:'train'};
const modeNames={walk:'步行',drive:'驾车',cycle:'骑行',transit:'公共交通'};
const asArray=v=>Array.isArray(v)?v:[];
export function googleDuration(value){
  return typeof value==='string'&&/^\d+(?:\.\d{1,9})?s$/.test(value)?numberOrNull(value.slice(0,-1)):null;
}
function coordinate(location){
  const p=location?.latLng;
  return p&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&Math.abs(p.latitude)<=90&&Math.abs(p.longitude)<=180?[p.latitude,p.longitude]:null;
}
function geometry(polyline){
  const g=polyline?.geoJsonLinestring;
  if(g?.type!=='LineString'||!Array.isArray(g.coordinates)||g.coordinates.length<2)return [];
  if(g.coordinates.some(p=>!Array.isArray(p)||p.length<2||!Number.isFinite(p[0])||!Number.isFinite(p[1])||Math.abs(p[0])>180||Math.abs(p[1])>90))return [];
  return g.coordinates.map(p=>[p[1],p[0]]);
}
const sumKnown=values=>values.every(v=>v!==null)?values.reduce((n,v)=>n+v,0):null;
const minutes=seconds=>seconds===null?null:Math.ceil(seconds/60);
const safeUrl=value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:null;}catch{return null;}};

export function googleRouteRequest(a,b,{mode='walking',strategy='balanced',departure=null,timeZone=null,now=Date.now(),selections={}}={}){
  if(!modes[mode])throw Object.assign(Error('出行方式无效'),{status:400});
  const point=p=>{
    if(!Number.isFinite(p.lat)||!Number.isFinite(p.lng)||Math.abs(p.lat)>90||Math.abs(p.lng)>180)throw Object.assign(Error('地点坐标无效'),{status:400});
    return {location:{latLng:{latitude:p.lat,longitude:p.lng}}};
  };
  const selectedPoint=(p,ref)=>{
    if(!ref)return point(p);
    if(ref.provider!=='google'||typeof ref.id!=='string'||!ref.id||ref.id.length>256||/[\s\u0000-\u001f]/u.test(ref.id))throw Object.assign(Error('地图候选与路线供应商不一致，请重新匹配'),{status:409});
    return {placeId:ref.id};
  };
  const body={origin:selectedPoint(a,selections.from),destination:selectedPoint(b,selections.to),travelMode:modes[mode],computeAlternativeRoutes:true,polylineEncoding:'GEO_JSON_LINESTRING',polylineQuality:'HIGH_QUALITY',languageCode:'zh-CN',units:'METRIC'};
  if(mode==='transit'){
    const preference={fewTransfers:'FEWER_TRANSFERS',fewWalking:'LESS_WALKING'}[strategy];
    if(preference)body.transitPreferences={routingPreference:preference};
    if(departure){
      body.departureTime=departureInstant(departure,timeZone||placeTimeZone(a));
      const when=Date.parse(body.departureTime);
      if(when<now-7*86400000||when>now+100*86400000)throw Object.assign(Error('Google 公交出发时间须在过去 7 天至未来 100 天内，远期班次仍可能调整'),{status:400});
    }
  }
  return body;
}

export function googleAlternatives(response,mode,strategy='balanced'){
  const result=[];
  for(const [index,route] of asArray(response?.routes).entries()){
    const legs=asArray(route.legs);
    if(!legs.length||legs.some(leg=>!asArray(leg.steps).length))continue;
    const segments=[];let pending=[],pendingMode=null,complete=true;
    const flush=()=>{
      if(!pending.length)return;
      const seconds=sumKnown(pending.map(s=>s.durationSeconds));
      segments.push({mode:pendingMode,instruction:pending.map(s=>s.instruction).join('；'),durationSeconds:seconds,minutes:minutes(seconds),distanceMeters:sumKnown(pending.map(s=>s.distanceMeters)),steps:pending,
        polyline:pending.flatMap(s=>s.polyline),mapPolyline:pending.flatMap(s=>s.polyline.map(([lat,lng])=>[lng,lat])),start:pending[0].start,end:pending.at(-1).end});
      pending=[];pendingMode=null;
    };
    for(const leg of legs)for(const raw of leg.steps){
      const travel=raw.travelMode,polyline=geometry(raw.polyline),seconds=googleDuration(raw.staticDuration);
      const step={instruction:raw.navigationInstruction?.instructions||'沿路线前行',action:raw.navigationInstruction?.maneuver||null,
        distanceMeters:numberOrNull(raw.distanceMeters),durationSeconds:seconds,polyline,
        start:coordinate(raw.startLocation)||polyline[0]||null,end:coordinate(raw.endLocation)||polyline.at(-1)||null};
      if(localModes[travel]){
        if(pendingMode&&pendingMode!==localModes[travel])flush();
        pendingMode=localModes[travel];pending.push(step);continue;
      }
      flush();
      if(travel!=='TRANSIT'){complete=false;continue;}
      const d=raw.transitDetails||{},stops=d.stopDetails||{},line=d.transitLine||{},vehicle=vehicleModes[line.vehicle?.type]||'transit';
      const from=stops.departureStop?.name||'上车站待核实',to=stops.arrivalStop?.name||'下车站待核实';
      segments.push({mode:vehicle,instruction:`${from} → ${to} · ${line.nameShort||line.name||'公共交通'}${d.headsign?' · 开往 '+d.headsign:''}`,
        line:line.nameShort||line.name||null,boarding:stops.departureStop?.name||null,alighting:stops.arrivalStop?.name||null,
        departureTime:stops.departureTime||null,arrivalTime:stops.arrivalTime||null,
        departureLocal:d.localizedValues?.departureTime?.time?.text||null,departureTimeZone:d.localizedValues?.departureTime?.timeZone||null,
        arrivalLocal:d.localizedValues?.arrivalTime?.time?.text||null,arrivalTimeZone:d.localizedValues?.arrivalTime?.timeZone||null,
        agencies:asArray(line.agencies).map(x=>({name:x.name||'',url:safeUrl(x.uri)})),stopCount:numberOrNull(d.stopCount),
        durationSeconds:seconds,minutes:minutes(seconds),distanceMeters:step.distanceMeters,steps:[],polyline,mapPolyline:polyline.map(([lat,lng])=>[lng,lat]),
        start:coordinate(stops.departureStop?.location)||step.start,end:coordinate(stops.arrivalStop?.location)||step.end});
    }
    flush();
    if(!complete||!segments.length)continue;
    result.push(finalizeAlternative({label:`${mode==='transit'?'公共交通':modeNames[localModes[modes[mode]]]}方案 ${index+1}`,
      description:route.description||null,warnings:asArray(route.warnings).filter(x=>typeof x==='string'),durationSeconds:googleDuration(route.duration),distanceMeters:numberOrNull(route.distanceMeters),segments}));
  }
  return rankAlternatives(result,strategy);
}

export function googlePlaceRequest(place){
  return {textQuery:place.name,languageCode:'zh-CN',pageSize:5,
    locationBias:{circle:{center:{latitude:place.lat,longitude:place.lng},radius:3000}}};
}
export function googlePlaceCandidates(response){
  return asArray(response?.places).map(p=>({id:p.id,name:p.displayName?.text||'',address:p.formattedAddress||'',type:asArray(p.types).join(', '),
    coord_system:'WGS84',point:coordinate({latLng:p.location}),mapsUrl:safeUrl(p.googleMapsUri),
    attributions:asArray(p.attributions).map(a=>({name:a.provider||'',url:safeUrl(a.providerUri)}))}));
}
