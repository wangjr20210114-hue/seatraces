import {dayBudget,visitAllowance} from './day-budget.mjs';
import {distance} from '../planner.mjs';
const canonical=s=>String(s||'').normalize('NFKC').replace(/[\s·•（）()]/g,'').toLowerCase();
export const nameMatches=(place,names=[])=>names.some(n=>[place.name,...(place.aliases||[])].some(s=>canonical(s)===canonical(n)));
export function allowedByCurrentTrip(place,prefs={}){
  if(nameMatches(place,prefs.avoidPlaceNames))return false;
  return place.wanted||prefs.revisit!=='new'||!nameMatches(place,prefs.visitedNames);
}
export function constrainedBudget(prefs={},transfer=false){
  const b=dayBudget(prefs.pace,transfer);
  if(prefs.endBy){const [h,m]=prefs.endBy.split(':').map(Number);b.end=Math.min(b.end,h*60+m);}
  return {...b,availableMinutes:Math.max(0,b.end-b.start),endSource:prefs.endBy?'current_explicit':'pace_rule'};
}
export function visitDuration(place,prefs={}){
  const a=visitAllowance(place);
  if(a.source!=='planning_allowance'||!prefs.travelFocus)return a;
  return {...a,minutes:Math.ceil(a.minutes*(prefs.travelFocus==='immersive'?1.25:prefs.travelFocus==='famous'?.85:1)),source:'planning_allowance_'+prefs.travelFocus};
}
export function walkingEstimate(previous,place,prefs={}){
  if(!previous)return 0;
  // Explicitly an allowance, never actual road or in-attraction walking distance.
  const km=distance(previous,place);
  return km<=1.2&&prefs.transport!=='fewWalking'?km*1.3:.6;
}
