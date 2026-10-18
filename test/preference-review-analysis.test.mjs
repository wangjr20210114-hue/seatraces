import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {aggregateReviews,renderAnalysis} from '../scripts/lib/preference-review-analysis.mjs';

const study={protocolId:'frozen',tasks:[{id:'a',scenario:'园林',options:[{key:'x',title:'湖边'},{key:'y',title:'展馆'}]},{id:'b',scenario:'艺术',options:[{key:'x',title:'湖边'},{key:'y',title:'展馆'}]},{id:'c',scenario:'园林',options:[{key:'x',title:'湖边'},{key:'y',title:'展馆'}]}]};
const protocol={protocolId:'frozen',probes:[{taskId:'a',methods:['rule','tower'],preferredKeys:['x','y']},{taskId:'b',methods:['rule','semantic'],preferredKeys:['x','y']},{taskId:'c',repeatOf:'a'}]};
const answers=choices=>({protocolId:'frozen',reviewerId:randomUUID(),responses:study.tasks.map((t,i)=>({taskId:t.id,order:['x','y'],choice:choices[i],elapsedMs:1000}))});

test('no human evidence yields no ranking conclusions',()=>{
  const r=aggregateReviews(study,protocol,[]);assert.equal(r.status,'awaiting_reviews');assert.equal(r.reviewerCount,0);assert.deepEqual(r.totals,{});assert.deepEqual(r.tasks,[]);assert.equal(r.activationAllowed,false);
  assert.match(renderAnalysis(r),/不能给出模型优劣结论/);
});
test('case-insensitive reviewer deduplication requires explicit final revision selection',()=>{
  const a=answers(['first','both','first']),b=structuredClone(a);b.reviewerId=b.reviewerId.toUpperCase();b.responses[0].choice='second';
  assert.throws(()=>aggregateReviews(study,protocol,[a,a]),/Multiple submissions/);assert.throws(()=>aggregateReviews(study,protocol,[a,b]),/Multiple submissions/);
});
test('aggregate respects shuffled sides, non-preferences, repeats and disagreement ordering',()=>{
  const a=answers(['first','both','first']),b=answers(['first','neither','unsure']);b.responses[0].order.reverse();
  const r=aggregateReviews(study,protocol,[a,b]);
  assert.equal(r.reviewerCount,2);assert.equal(r.totals['rule vs tower'].tasks,2);assert.equal(r.totals['rule vs tower'].firstMethodWins,1);assert.equal(r.totals['rule vs tower'].secondMethodWins,1);
  assert.equal(r.totals['rule vs semantic'].both,1);assert.equal(r.totals['rule vs semantic'].neither,1);assert.equal(r.tasks.length,2);assert.equal(r.tasks[0].disagreement,.5);
  assert.deepEqual(r.reviewers.map(x=>x.repeatAgreements),[1,0]);assert.equal(r.activationAllowed,false);
  const before=structuredClone(a);aggregateReviews(study,protocol,[a]);assert.deepEqual(a,before);
});
test('aggregate rejects unknown studies and incomplete data without producing a partial result',()=>{
  const a=answers(['unsure','second','both']);assert.throws(()=>aggregateReviews(study,{...protocol,protocolId:'other'},[a]),/Protocol mismatch/);
  a.responses.pop();assert.throws(()=>aggregateReviews(study,protocol,[a]));
});
