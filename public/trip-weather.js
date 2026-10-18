export function mountTripWeather({element,trip,day,api}){
  const area=document.createElement('section');area.className='trip-day trip-weather';
  const open=document.createElement('button');open.className='inline-action';open.textContent='天气与预警 ☀';
  const result=document.createElement('div');result.setAttribute('role','status');area.append(open,result);element.append(area);
  open.onclick=async()=>{
    open.disabled=true;result.textContent='正在查看天气…';
    try{
      const base='/api/journey/trips/'+encodeURIComponent(trip.id),qs='?day='+day;
      const [weather,alerts]=await Promise.all([api(base+'/weather'+qs),api(base+'/weather-alerts'+qs).catch(()=>({status:'unavailable',items:[]}))]);
      if(!area.isConnected)return;
      result.replaceChildren();
      const add=text=>{const p=document.createElement('p');p.textContent=text;result.append(p);};
      if(weather.forecast){const f=weather.forecast;add(`${f.day} · ${f.lowC??'—'}～${f.highC??'—'}℃`);
        if(weather.advice)add('天气可能影响户外游览，可考虑室内备选');
      }else add(weather.status==='outside_forecast_range'?'出行日期尚未进入预报范围':'天气暂不可用');
      if(alerts.items?.length)for(const item of alerts.items){add(item.title);if(item.instruction)add(item.instruction);}
      else add(alerts.status==='available'?'当前未收到适用于当天的有效预警':alerts.status==='not_configured'?'官方预警服务尚未配置':'当前预警数据不可用');
      for(const attribution of alerts.attributions||[])add(attribution);
    }catch(e){if(area.isConnected)result.textContent=e.message;}
    finally{open.disabled=false;}
  };
}
