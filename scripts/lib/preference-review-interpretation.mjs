/* 解释偏好选择和重复题结果，汇总选择含义。 */

export function interpretChoice(response) {
  const keys=[...response.order];
  if(response.choice==='both')return {acceptedKeys:keys,rejectedKeys:[],unratedKeys:[],preference:null};
  if(response.choice==='neither')return {acceptedKeys:[],rejectedKeys:keys,unratedKeys:[],preference:null};
  if(response.choice==='unsure')return {acceptedKeys:[],rejectedKeys:[],unratedKeys:keys,preference:null};
  if(!['first','second'].includes(response.choice))throw Error('Unknown choice');
  const first=response.choice==='first'?0:1;
  return {acceptedKeys:[],rejectedKeys:[],unratedKeys:keys,preference:{preferred:keys[first],over:keys[1-first]}};
}

export function compareRepeatedChoices(original, repeated) {
  const a=interpretChoice(original),b=interpretChoice(repeated);
  if(a.acceptedKeys.some(k=>b.rejectedKeys.includes(k))||b.acceptedKeys.some(k=>a.rejectedKeys.includes(k)))return 'acceptability_conflict';
  if(a.preference&&b.preference&&a.preference.preferred!==b.preference.preferred)return 'preference_reversal';
  if(original.choice==='unsure'||repeated.choice==='unsure')return 'undetermined';
  if((original.choice==='neither'&&b.preference)||(repeated.choice==='neither'&&a.preference))return 'undetermined';
  return 'compatible';
}

export function summarizeChoiceSemantics(protocol, answers) {
  const byId=new Map(answers.responses.map(r=>[r.taskId,r]));
  const primary={bothSuitableAnswers:0,neitherSuitableAnswers:0,relativePreferenceAnswers:0,unsureAnswers:0,
    acceptedItemJudgments:0,rejectedItemJudgments:0,unratedItemJudgments:0};
  const repeats={compatible:0,acceptability_conflict:0,preference_reversal:0,undetermined:0,items:[]};
  for(const probe of protocol.probes){
    const response=byId.get(probe.taskId);
    if(probe.repeatOf){
      const interpretation=compareRepeatedChoices(byId.get(probe.repeatOf),response);
      repeats[interpretation]++;
      repeats.items.push({taskId:probe.taskId,repeatOf:probe.repeatOf,interpretation});
      continue;
    }
    const x=interpretChoice(response);
    primary.acceptedItemJudgments+=x.acceptedKeys.length;
    primary.rejectedItemJudgments+=x.rejectedKeys.length;
    primary.unratedItemJudgments+=x.unratedKeys.length;
    if(x.preference)primary.relativePreferenceAnswers++;
    else primary[{both:'bothSuitableAnswers',neither:'neitherSuitableAnswers',unsure:'unsureAnswers'}[response.choice]]++;
  }
  return {version:'choice-semantics/1',analysisTiming:'post_hoc',primary,repeats,
    countingUnit:'Scenario-conditioned item judgments, not unique posts or independent users',
    trainingLabelsExported:false,profileWrites:false,activationAllowed:false};
}
