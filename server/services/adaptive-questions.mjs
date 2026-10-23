/* 根据已有旅行信息和兴趣信号生成后续问卷题目。 */

import {z} from 'zod';
import {journeyAnswers} from './journey-draft.mjs';
import {orderedInterestOptions} from './questions.mjs';
import {questionBank} from '../planner.mjs';

export const suppliedAnswers=z.object(Object.fromEntries(Object.entries(journeyAnswers.shape).map(([k,v])=>[k,v.removeDefault?.().optional()||v.optional()]))).strict();
export const adaptiveInput=z.object({answers:suppliedAnswers.default({})}).strict();
const one=(id,title,options,reason)=>({id,title,type:'single',options:options.map(([value,label])=>({value,label})),reason});
export function adaptiveQuestions(preferences={},supplied={},context={}){
  const known=suppliedAnswers.parse(supplied),questions=[];
  const add=q=>{if(!Object.hasOwn(known,q.id))questions.push(q);};
  add(one('companion','这次和谁一起出发？',[
    ['solo','一个人'],['couple','两个人'],['friends','朋友'],['parents','带父母'],['family','带孩子或家人']], 'trip_context'));
  const interest=structuredClone(questionBank[0]);
  interest.options=orderedInterestOptions(interest.options,preferences);
  const strong=interest.options.filter(t=>(preferences.styleWeights?.[t]??preferences.tagWeights?.[t]??0)>=.3).slice(0,2);
  if(strong.length)interest.title=`这次也想逛${strong.join('、')}，还是换个主题？`;
  interest.reason=strong.length?'confirm_inferred_interest':'unknown_interest';add(interest);
  for(const base of questionBank.slice(1)){
    const q=structuredClone(base),suggestion=preferences.suggestions?.[q.id];
    if(suggestion)q.options.sort((a,b)=>Number(b.value===suggestion.value)-Number(a.value===suggestion.value));
    if(q.id==='pace'&&known.companion==='parents')q.title='这次想逛得轻松些，还是多安排一些？';
    else if(q.id==='pace'&&suggestion?.value==='relaxed')q.title='这次想放慢一点，还是保持原来的节奏？';
    add({...q,reason:suggestion?'confirm_behavioral_suggestion':'unknown_'+q.id});
  }
  if(known.transport==='fewWalking')add(one('walkingLimitKm','每天步行控制在多少以内？',[[3,'约 3 公里'],[5,'约 5 公里'],[8,'约 8 公里']],'walking_constraint'));
  if((known.interests||[]).some(t=>['人文','艺术','园林'].includes(t)))add(one('travelFocus','喜欢的地方，想怎样逛？',[
    ['immersive','少选几处，留时间细逛'],['famous','多覆盖经典地点'],['balanced','两者兼顾']],'visit_depth'));
  if(known.companion==='parents'||known.transport==='fewWalking')add(one('endBy','每天希望几点结束游览？',[
    ['17:00','下午五点'],['18:00','下午六点'],['19:00','晚上七点']],'day_end_constraint'));
  if(known.companion==='family'||(known.interests||[]).some(t=>['夜景','亲子'].includes(t)))add(one('crowd','热闹一点，还是清静一点？',[
    ['avoid','想躲开人群'],['balanced','都可以'],['lively','热闹也不错']],'crowd_context'));
  if(known.visitedNames?.length||context.completedTrips>0)add(one('revisit','去过的地方，这次还想安排吗？',[
    ['new','这次探索新地方'],['either','喜欢的地方值得重游']],'known_visits'));
  return {schemaVersion:'adaptive-questions/1',questions,known,source:'有条件的问题流程',
    defaults:journeyAnswers.parse({...Object.fromEntries(Object.entries(preferences).filter(([k])=>Object.hasOwn(journeyAnswers.shape,k))),...known,interests:known.interests||preferences.interests||[]}),
    ready:questions.length===0,
    constraints:Object.fromEntries(Object.entries(known).map(([k,value])=>[k,{value,source:'current_explicit'}]))};
}

export function installAdaptiveQuestions(app,{auth,query,ownSession,travelHabit}){
  app.post('/api/journey/sessions/:id/questions',auth,async(req,res)=>{
    const session=await ownSession(req.params.id,req.user.id),input=adaptiveInput.parse(req.body||{});
    const habit=await travelHabit(req.user),r=adaptiveQuestions(habit,input.answers,{...session.request,completedTrips:habit.completedTrips});
    await query('UPDATE journey_sessions SET questions=$2,updated_at=now() WHERE id=$1',[session.id,JSON.stringify(r)]);
    res.json(r);
  });
}
