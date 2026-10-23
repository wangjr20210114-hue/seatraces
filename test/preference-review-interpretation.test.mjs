/* 验证人工偏好选择解释。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {interpretChoice,compareRepeatedChoices,summarizeChoiceSemantics} from '../scripts/lib/preference-review-interpretation.mjs';

const response=(choice,order=['x','y'])=>({choice,order});
test('absolute suitability and relative preferences remain distinct',()=>{
  assert.deepEqual(interpretChoice(response('both')),{acceptedKeys:['x','y'],rejectedKeys:[],unratedKeys:[],preference:null});
  assert.deepEqual(interpretChoice(response('neither')),{acceptedKeys:[],rejectedKeys:['x','y'],unratedKeys:[],preference:null});
  for(const choice of ['first','second']){
    const a=interpretChoice(response(choice));assert.deepEqual(a.acceptedKeys,[]);assert.deepEqual(a.rejectedKeys,[]);assert.deepEqual(a.unratedKeys,['x','y']);
    assert.equal(a.preference.preferred,choice==='first'?'x':'y');assert.notEqual(a.preference.preferred,a.preference.over);
  }
  assert.deepEqual(interpretChoice(response('unsure')),{acceptedKeys:[],rejectedKeys:[],unratedKeys:['x','y'],preference:null});
  assert.throws(()=>interpretChoice(response('invented')),/Unknown choice/);
});

test('all 25 repeated-choice combinations have symmetric, conservative interpretations',()=>{
  const options=['first','second','both','neither','unsure'];
  const expected=[
    ['compatible','preference_reversal','compatible','undetermined','undetermined'],
    ['preference_reversal','compatible','compatible','undetermined','undetermined'],
    ['compatible','compatible','compatible','acceptability_conflict','undetermined'],
    ['undetermined','undetermined','acceptability_conflict','compatible','undetermined'],
    ['undetermined','undetermined','undetermined','undetermined','undetermined'],
  ];
  for(let i=0;i<5;i++)for(let j=0;j<5;j++){
    assert.equal(compareRepeatedChoices(response(options[i]),response(options[j])),expected[i][j]);
    assert.equal(expected[i][j],expected[j][i]);
    const flipped=options[j]==='first'?'second':options[j]==='second'?'first':options[j];
    assert.equal(compareRepeatedChoices(response(options[i]),response(flipped,['y','x'])),expected[i][j]);
  }
});

test('supplement excludes repeats from suitability counts and never changes input or permissions',()=>{
  const protocol={probes:[{taskId:'a'},{taskId:'b'},{taskId:'c'},{taskId:'d'},{taskId:'e',repeatOf:'a'},{taskId:'f',repeatOf:'b'}]};
  const answers={responses:['both','neither','second','unsure','first','both'].map((c,i)=>({taskId:'abcdef'[i],...response(c)}))};
  const before=structuredClone(answers),s=summarizeChoiceSemantics(protocol,answers);
  assert.deepEqual(s.primary,{bothSuitableAnswers:1,neitherSuitableAnswers:1,relativePreferenceAnswers:1,unsureAnswers:1,acceptedItemJudgments:2,rejectedItemJudgments:2,unratedItemJudgments:4});
  assert.equal(s.repeats.compatible,1);assert.equal(s.repeats.acceptability_conflict,1);assert.equal(s.repeats.items.length,2);
  assert.equal(s.analysisTiming,'post_hoc');assert.equal(s.trainingLabelsExported,false);assert.equal(s.profileWrites,false);assert.equal(s.activationAllowed,false);assert.deepEqual(answers,before);
});
