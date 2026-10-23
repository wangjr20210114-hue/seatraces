/* 根据有效期整理地点事实的可用状态。 */

export function factValidity(fact,date=new Date().toISOString().slice(0,10),now=Date.now()){
 const e=fact?.evidence||{},due=e.reviewAfter||fact?.expiresAt,checked=e.retrievedAt||fact?.verifiedAt;
 const expired=Boolean(due&&(!Number.isFinite(Date.parse(due))||Date.parse(due)<=now));
 const outside=Boolean(e.validFrom&&date<e.validFrom.slice(0,10)||e.validThrough&&date>e.validThrough.slice(0,10));
 const accepted=e.reviewStatus==='accepted',checkedValid=checked&&Number.isFinite(Date.parse(checked))&&Date.parse(checked)<=now;
 const status=expired?'expired':outside?'outside_valid_dates':!accepted?'unreviewed':(!checkedValid||!due||fact?.status==='needs_review')?'needs_review':'current';
 return {status,usable:status==='current'&&fact?.value!=null,sourceUrl:fact?.sourceUrl||null,checkedAt:checked||null,reviewAfter:due||null,validFrom:e.validFrom||null,validThrough:e.validThrough||null};
}
export function applyFactValidity(place,date,now=Date.now()){
 const facts={},quality={};for(const [field,fact]of Object.entries(place.facts||{})){
  if(!fact||typeof fact!=='object'){facts[field]=fact;continue;}
  const v=factValidity(fact,date,now);quality[field]=v;
  facts[field]=fact.source==='OpenStreetMap'?fact:v.usable?fact:{...fact,value:null,status:v.status};
 }
 return {...place,facts,factQuality:quality};
}
