/* 整理当前城市、行程和兴趣，供推荐请求使用。 */

export function recommendationContext({pendingTrip,trip,userId,now=Date.now()}={}){
  const current=pendingTrip||trip?.user_id===userId&&trip?.request;
  if(!current)return {};
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const start=Date.parse(current.start+'T00:00:00+08:00'),end=Date.parse(current.end+'T23:59:59+08:00');
  if(!Number.isFinite(start)||!Number.isFinite(end)||current.end<today||start>now+30*86400000)return {};
  const city=current.cities?.[0]?.name;
  return typeof city==='string'&&city.length<=100?{city}:{};
}
