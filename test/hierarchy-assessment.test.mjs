/* 验证景区层级评估。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAssessmentJobs,assessmentJobHash,validateAssessment,modelCostUpper,modelUsageEstimate} from '../server/domain/hierarchy-assessment.mjs';
import {overlayScenicHierarchy} from '../server/domain/scenic-hierarchy.mjs';

const parent={id:'osm:way/1',name:'景区',aliases:[],lat:30,lng:120,cityId:'a',city:'甲',rawTags:{tourism:'museum'}};
const child={...parent,id:'osm:node/2',name:'园内亭',rawTags:{tourism:'attraction'}};
const other={...parent,id:'osm:node/3',name:'乙地',cityId:'b',city:'乙',rawTags:{tourism:'attraction'}};
const data={points:[parent,child,other],geometries:{},results:[parent,child,other].map(p=>({placeId:p.id,candidates:[]}))};
const input=buildAssessmentJobs(data,new Set([parent.id]))[0];
const answer={items:[{id:child.id,verdict:'child_candidate',parentId:parent.id,basis:'spatial_name',evidenceId:null,quote:null,reason:'名称与邻近位置提示候选，尚未核实。'}]};

test('every pending place is covered once, including those without a parent option',()=>{
  const jobs=buildAssessmentJobs(data,new Set([parent.id]));
  assert.deepEqual(jobs.flatMap(j=>j.places.map(p=>p.id)),[child.id,other.id]);
  assert.equal(jobs[0].places[0].parentOptions[0].id,parent.id);
  assert.equal(jobs[0].places[0].parentOptions[0].polygonContains,false);
  assert.equal(jobs[1].places[0].parentOptions.length,0);
  assert.equal(assessmentJobHash(input,'test'),assessmentJobHash(structuredClone(input),'test'));
});

test('model suggestions remain unverified and cannot alter the published hierarchy',()=>{
  const assessment=validateAssessment(answer,input)[0];
  assert.equal(assessment.requiresReview,true);
  assert.equal(assessment.status,'unverified_model_assessment');
  const rows=new Map([[child.id,{status:'unknown',parentId:null,modelAssessment:assessment}]]);
  assert.equal(overlayScenicHierarchy([parent,child],rows)[1].parentId,undefined);
});

test('incomplete coverage, invented parent IDs, and fabricated evidence are rejected',()=>{
  assert.throws(()=>validateAssessment({items:[]},input),/incomplete_items/);
  assert.throws(()=>validateAssessment({items:[{...answer.items[0],parentId:'invented'}]},input),/invalid_parent/);
  assert.throws(()=>validateAssessment({items:[{...answer.items[0],basis:'official_excerpt',evidenceId:'invented',quote:'不存在'}]},input),/invalid_evidence/);
  const withEvidence=structuredClone(input);
  withEvidence.places[0].evidence=[{id:'s1',parentId:parent.id,text:'园内亭属于景区。',sha256:'test',url:'https://example.org'}];
  const cited={items:[{...answer.items[0],basis:'official_excerpt',evidenceId:'s1',quote:'园内亭属于景区'}]};
  assert.equal(validateAssessment(cited,withEvidence)[0].requiresReview,true);
});

test('cost reservation exceeds measured token estimate; missing usage is not treated as free',()=>{
  assert.equal(modelUsageEstimate({prompt_tokens:1000,completion_tokens:1000}),0.01);
  assert.equal(modelUsageEstimate(null),null);
  assert.ok(modelCostUpper({messages:[{content:'景区'.repeat(100)}]})>=modelUsageEstimate({prompt_tokens:100,completion_tokens:1800}));
});
