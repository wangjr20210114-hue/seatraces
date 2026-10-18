import {z} from 'zod';
import {amap} from '../integrations/amap.mjs';
import {toGcj} from '../../public/coordinates.js';
import {createWeatherAlerts} from '../integrations/weather-alerts.mjs';
const fail=(s,status=400)=>Object.assign(Error(s),{status});
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const n=Date.parse(s+'T12:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===s;});
export async function weatherAdcode(city,call=amap){
  if(/^\d{6}$/.test(city.adcode||''))return city.adcode;
  const r=await call('v3/geocode/regeo',{location:toGcj(city),extensions:'base',radius:100});
  const code=r.regeocode?.addressComponent?.adcode;
  return typeof code==='string'&&/^\d{6}$/.test(code)?code:null;
}
export function normalizeForecast(raw,now=Date.now()){
  const forecast=raw?.forecasts?.[0];
  if(!forecast||!Array.isArray(forecast.casts))throw fail('天气预报暂不可用',502);
  const reportedAt=new Date(String(forecast.reporttime||'').replace(' ','T')+'+08:00');
  if(!Number.isFinite(+reportedAt)||+reportedAt>now+300000)throw fail('天气发布时间无法核验',502);
  const days=forecast.casts.slice(0,7).flatMap(c=>{
    if(!date.safeParse(c.date).success)return [];
    const text=String(c.dayweather||'').slice(0,40),night=String(c.nightweather||'').slice(0,40);
    const temp=v=>v!==''&&v!=null&&Number.isFinite(Number(v))?Number(v):null;
    const high=temp(c.daytemp),low=temp(c.nighttemp),risks=[];
    if(/雨|雪|雷|冰雹/.test(text+' '+night))risks.push('precipitation');
    if(high!==null&&high>=35)risks.push('heat');
    if(low!==null&&low<=0)risks.push('freezing');
    return [{date:c.date,day:text,night,highC:high,lowC:low,risks}];
  });
  return {provider:'amap',reportedAt:reportedAt.toISOString(),checkedAt:new Date(now).toISOString(),
    expiresAt:new Date(Math.min(now+3600000,+reportedAt+12*3600000)).toISOString(),days,
    alerts:{status:'unavailable',items:[],reason:'amap_forecast_does_not_provide_official_alerts'}};
}
export function weatherForDate(payload,day,now=Date.now()){
  const found=payload.days.find(d=>d.date===day);
  const status=Date.parse(payload.expiresAt)<=now?'stale':found?'available':'outside_forecast_range';
  return {status,...payload,forecast:status==='available'?found:null,
    advice:status==='available'&&found.risks.length?'indoor_alternative':null};
}
export function createWeatherService({query,call=amap,resolveCode=city=>weatherAdcode(city,call),now=Date.now,enabled=()=>Boolean(process.env.AMAP_KEY)}={}){
  const pending=new Map();
  async function get(city,day){
    date.parse(day);
    if(city.country!=='CN')return {status:'unsupported',forecast:null,alerts:{status:'unavailable',items:[]}};
    if(!enabled())return {status:'not_configured',forecast:null,alerts:{status:'unavailable',items:[]}};
    const key=String(city.id||`${city.lat}:${city.lng}`).slice(0,200);
    const cached=(await query('SELECT payload FROM city_weather_cache WHERE city_key=$1 AND expires_at>now()',[key])).rows[0];
    if(cached)return weatherForDate(cached.payload,day,now());
    if(!pending.has(key)){
      if(pending.size>=32)throw fail('天气查询较多，请稍后重试',503);
      const task=(async()=>{
        const adcode=await resolveCode(city);
        if(!/^\d{6}$/.test(adcode||''))return null;
        const payload=normalizeForecast(await call('v3/weather/weatherInfo',{city:adcode,extensions:'all'}),now());
        await query(`INSERT INTO city_weather_cache(city_key,payload,expires_at,adcode) VALUES($1,$2,$3,$4)
         ON CONFLICT(city_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at,adcode=excluded.adcode,checked_at=now()`,[key,payload,payload.expiresAt,adcode]);
        return payload;
      })().finally(()=>pending.delete(key));pending.set(key,task);
    }
    const payload=await pending.get(key);
    return payload?weatherForDate(payload,day,now()):{status:'city_unresolved',forecast:null,alerts:{status:'unavailable',items:[]}};
  }
  return {get};
}
export function installWeatherRoutes(app,{auth,query,service=createWeatherService({query}),alerts=createWeatherAlerts()}){
  app.get('/api/journey/trips/:id/weather',auth,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),index=z.coerce.number().int().min(0).max(29).default(0).parse(req.query.day);
    const trip=(await query('SELECT plan FROM trips WHERE id=$1 AND user_id=$2',[id,req.user.id])).rows[0];
    if(!trip)throw fail('行程不存在',404);
    const day=trip.plan.days?.[index],city=trip.plan.cities?.find(c=>c.id===day?.cityId);
    if(!day||!city)throw fail('旅行日期不存在',404);
    let r;
    try{r=await service.get(city,day.date);}catch{r={status:'unavailable',forecast:null};}
    res.json({...r,day:index,indoorStops:r.advice?(day.stops||[]).filter(p=>p.traits?.tourism==='museum'||p.traits?.tourism==='gallery'||p.traits?.indoor==='yes').map(p=>({id:p.id,name:p.name})):[]});
  });
  const pending=new Map();
  app.get('/api/journey/trips/:id/weather-alerts',auth,async(req,res)=>{
    const id=z.uuid().parse(req.params.id),index=z.coerce.number().int().min(0).max(29).default(0).parse(req.query.day);
    const trip=(await query('SELECT plan FROM trips WHERE id=$1 AND user_id=$2',[id,req.user.id])).rows[0];
    if(!trip)throw fail('行程不存在',404);
    const day=trip.plan.days?.[index],city=trip.plan.cities?.find(c=>c.id===day?.cityId);if(!day||!city)throw fail('旅行日期不存在',404);
    if(city.country!=='CN')return res.json({status:'unsupported',items:[],scope:'current_alerts'});
    const key=String(city.id),cached=(await query('SELECT payload FROM city_weather_alerts WHERE city_key=$1 AND expires_at>now()',[key])).rows[0];
    if(!cached&&!pending.has(key)){
      if(pending.size>=32)throw fail('预警查询较多，请稍后重试',503);
      const work=(async()=>{const result=await alerts(city);if(result.status!=='not_configured')await query(`INSERT INTO city_weather_alerts(city_key,payload,expires_at) VALUES($1,$2,now()+interval '5 minutes')
      ON CONFLICT(city_key) DO UPDATE SET payload=excluded.payload,checked_at=now(),expires_at=excluded.expires_at`,[key,result]);return result;})().finally(()=>pending.delete(key));pending.set(key,work);
    }
    const result=cached?.payload||await pending.get(key),start=Date.parse(day.date+'T00:00:00+08:00'),end=start+86400000;
    res.json({...result,items:(result.items||[]).filter(a=>Date.parse(a.validThrough)>Math.max(start,Date.now())&&Date.parse(a.validFrom)<end)});
  });
}
