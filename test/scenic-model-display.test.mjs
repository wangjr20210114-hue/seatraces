/* 验证景区模型结果展示。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {overlayScenicHierarchy,hierarchyPlaceHash} from '../server/domain/scenic-hierarchy.mjs';
import {groupScenicEntities,representedIds,applyWishes} from '../server/domain/scenic-entities.mjs';

const point=(id,name=id)=>({id,name,lat:30,lng:120,city:'杭州',category:'attraction',traits:{}});
const parent=point('park','测试公园'), child=point('pavilion','湖心亭');
const row=(p,parentId)=>({status:'spatial_candidate',sourceHash:'snapshot',candidates:[{parentId,boundaryTouch:false}],modelAssessment:{
  status:'unverified_model_assessment',verdict:'child_candidate',parentId,sourceHash:'snapshot',inputHash:hierarchyPlaceHash(p),reason:'轮廓包含与名称支持建议',requiresReview:true}});
const enabled={includeModelSuggestions:true};
const rows=new Map([[parent.id,{status:'unknown',sourceHash:'snapshot'}],[child.id,row(child,parent.id)]]);

test('display suggestions retain review status, all original IDs, score inputs and wishes',()=>{
  const before=structuredClone(rows);
  const displayed=overlayScenicHierarchy([parent,child],rows,enabled);
  assert.equal(displayed[1].parentRelation.status,'model_suggested');
  const grouped=groupScenicEntities(displayed);
  assert.equal(grouped.length,1);
  assert.equal(grouped[0].children[0].groupingReviewNeeded,true);
  assert.deepEqual(new Set(grouped.flatMap(representedIds)),new Set([parent.id,child.id]));
  assert.equal(applyWishes(grouped[0],{[child.id]:true}).wanted,true);
  assert.deepEqual(rows,before);
  assert.equal(groupScenicEntities(overlayScenicHierarchy([parent,child],rows)).length,2);
});

test('nearby-only, boundary-touching, stale, independent and unknown outputs do not merge',()=>{
  for(const change of [r=>r.candidates=[],r=>r.candidates[0].boundaryTouch=true,
    r=>r.modelAssessment.inputHash='stale',r=>r.modelAssessment.sourceHash='old',
    r=>r.modelAssessment.verdict='independent_candidate',r=>r.modelAssessment.verdict='unknown']) {
    const changed=structuredClone(rows);change(changed.get(child.id));
    assert.equal(overlayScenicHierarchy([parent,child],changed,enabled)[1].parentId,undefined);
  }
});

test('provider roots and reviewed relationships retain precedence over model suggestions',()=>{
  const fixed={...child,parentId:null,parentLookup:{status:'root',provider:'amap'}};
  assert.equal(overlayScenicHierarchy([parent,fixed],rows,enabled)[1].parentId,null);
  const reviewed={...child,parentId:'official',parentRelation:{status:'evidence_reviewed'}};
  assert.equal(overlayScenicHierarchy([parent,reviewed],rows,enabled)[1].parentId,'official');
});

test('cycles are rejected and model ancestry remains labelled after flattening',()=>{
  const cyclic=new Map([[parent.id,row(parent,child.id)],[child.id,row(child,parent.id)]]);
  assert.ok(overlayScenicHierarchy([parent,child],cyclic,enabled).every(p=>!p.parentId));
  const leaf={...point('statue','雕像'),parentId:child.id,parentLookup:{status:'child',provider:'amap'},parentRelation:{provider:'amap'}};
  const grouped=groupScenicEntities(overlayScenicHierarchy([parent,child,leaf],rows,enabled));
  assert.equal(grouped[0].children.find(p=>p.id===leaf.id).groupingReviewNeeded,true);
});

test('deduplication keeps a confirmed provider root over an inferred duplicate',()=>{
  const inferred=overlayScenicHierarchy([parent,child],rows,enabled)[1];
  const duplicate={...point('duplicate',child.name),parentLookup:{status:'root',provider:'amap'},parentId:null};
  const grouped=groupScenicEntities([parent,inferred,duplicate]);
  assert.equal(grouped.length,2);
  assert.equal(grouped.find(p=>p.id===child.id).children.length,0);
});
