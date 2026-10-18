import {request} from './http.mjs';
export function normalizeAlerts(raw,now=Date.now()){
  if(!Array.isArray(raw?.alerts)||typeof raw?.metadata?.zeroResult!=='boolean')throw Object.assign(Error('天气预警响应无法核验'),{status:502});
  const rows=raw.alerts.slice(0,100),superseded=new Set(rows.flatMap(r=>r.messageType?.supersedes||[]));
  const items=rows.filter(r=>!superseded.has(r.id)&&r.messageType?.code!=='cancel'&&r.urgency!=='past'&&
    Number.isFinite(Date.parse(r.expireTime))&&Date.parse(r.expireTime)>now&&
    Number.isFinite(Date.parse(r.issuedTime))&&Date.parse(r.issuedTime)<=now+300000).map(r=>({
      id:String(r.id).slice(0,200),publisher:String(r.senderName||'').slice(0,200),
      title:String(r.headline||'').slice(0,300),description:String(r.description||'').slice(0,4000),
      instruction:String(r.instruction||'').slice(0,2000),severity:String(r.severity||'unknown').slice(0,30),
      issuedAt:r.issuedTime,validFrom:r.effectiveTime||r.issuedTime,validThrough:r.expireTime,
    }));
  return {status:raw.metadata.zeroResult?'no_data':'available',provider:'qweather',scope:'current_alerts',items,
    checkedAt:new Date(now).toISOString(),attributions:(raw.metadata.attributions||[]).slice(0,5).map(s=>String(s).slice(0,1000))};
}
export function createWeatherAlerts({env=process.env,requestJSON=request,now=Date.now}={}){
  return async city=>{
    if(!env.QWEATHER_API_HOST||!env.QWEATHER_API_KEY)return {status:'not_configured',items:[],scope:'current_alerts'};
    if(!/^[a-z0-9-]+\.qweatherapi\.com$/i.test(env.QWEATHER_API_HOST))throw Object.assign(Error('预警服务主机配置无效'),{status:503});
    if(!Number.isFinite(city.lat)||!Number.isFinite(city.lng)||Math.abs(city.lat)>90||Math.abs(city.lng)>180)throw Object.assign(Error('城市坐标无效'),{status:400});
    const url=`https://${env.QWEATHER_API_HOST}/weatheralert/v1/current/${city.lat.toFixed(2)}/${city.lng.toFixed(2)}?lang=zh`;
    return normalizeAlerts(await requestJSON('QWeather',url,{headers:{'X-QW-Api-Key':env.QWEATHER_API_KEY}}),now());
  };
}
