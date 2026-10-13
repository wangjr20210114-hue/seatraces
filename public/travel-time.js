// Interpret itinerary wall-clock times in the departure location, never the
// browser/server's own zone. Ambiguous DST times require a different selection.
export function placeTimeZone(place) {
  if(place?.timezone)return place.timezone;
  const countries={CN:'Asia/Shanghai',HK:'Asia/Hong_Kong',MO:'Asia/Macau',TW:'Asia/Taipei',JP:'Asia/Tokyo',KR:'Asia/Seoul',TH:'Asia/Bangkok',VN:'Asia/Ho_Chi_Minh',MY:'Asia/Kuala_Lumpur',SG:'Asia/Singapore',BN:'Asia/Brunei',MV:'Indian/Maldives'};
  const extracts={china:'Asia/Shanghai',taiwan:'Asia/Taipei',japan:'Asia/Tokyo','south-korea':'Asia/Seoul',thailand:'Asia/Bangkok',vietnam:'Asia/Ho_Chi_Minh',maldives:'Indian/Maldives','malaysia-singapore-brunei':'Asia/Singapore'};
  return countries[place?.country]||extracts[place?.extract_region]||'';
}
const invalid=message=>Object.assign(Error(message),{status:400});
export function departureInstant(value,timeZone) {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value||''))throw invalid('出发日期时间无效');
  const wall=Date.parse(value+':00Z');
  if(!Number.isFinite(wall)||new Date(wall).toISOString().slice(0,16)!==value)throw invalid('出发日期时间无效');
  if(!timeZone)throw invalid('请选择出发地时区，例如 Asia/Tokyo');
  let formatter;
  try{formatter=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch{throw invalid('出发地时区无效，请使用 IANA 时区名称');}
  const candidates=[];
  for(let offset=-14*60;offset<=14*60;offset+=15){
    const timestamp=wall-offset*60000;
    const p=Object.fromEntries(formatter.formatToParts(timestamp).map(v=>[v.type,v.value]));
    if(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`===value)candidates.push(timestamp);
  }
  if(!candidates.length)throw invalid('此当地时间不存在，可能处于夏令时跳时区间，请修改时间');
  if(candidates.length!==1)throw invalid('此当地时间因夏令时发生重复，请选择转换前后明确的时刻');
  return new Date(candidates[0]).toISOString();
}
