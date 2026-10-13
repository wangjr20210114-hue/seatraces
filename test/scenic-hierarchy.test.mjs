import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHierarchyProposal,overlayScenicHierarchy,estimateFinish} from '../server/domain/scenic-hierarchy.mjs';
import {buildEvidenceJobs,plainText} from '../server/services/hierarchy-evidence.mjs';
const parent={id:'osm:way/1',name:'园',aliases:[]},child={id:'osm:node/2',name:'清音亭',aliases:[]};
const source={id:'s1',url:'https://example.org/guide',text:'清音亭位于园内。',trust:'official_registry',fields:['relation'],parentNames:['园']};
const input={parent,children:[child],evidence:[source]};
const output={relations:[{childId:child.id,parentId:parent.id,evidenceId:'s1',quote:source.text}],facts:[],unresolved:[]};
test('evidence validation rejects invented quotes, IDs, and out-of-scope facts',()=>{
  assert.equal(validateHierarchyProposal(output,input).relations[0].status,'review_needed');
  assert.throws(()=>validateHierarchyProposal({...output,relations:[{...output.relations[0],quote:'编造的不存在原文'}]},input));
  assert.throws(()=>validateHierarchyProposal({...output,relations:[{...output.relations[0],parentId:'other'}]},input));
  assert.throws(()=>validateHierarchyProposal({...output,facts:[{placeId:child.id,field:'openingHours',value:'全天',evidenceId:'s1',quote:source.text}]},input));
});
test('provider root preserved; spatial candidates remain independent; source-supported membership applies',()=>{
  const rows=new Map([[child.id,{status:'child',parentId:parent.id,method:'osm_site_member'}]]);
  assert.equal(overlayScenicHierarchy([parent,{...child,parentLookup:{status:'root'}}],rows)[1].parentId,undefined);
  assert.equal(overlayScenicHierarchy([parent,child],rows)[1].parentId,parent.id);
  rows.get(child.id).status='spatial_candidate';
  assert.equal(overlayScenicHierarchy([parent,child],rows)[1].parentId,undefined);
});
test('model work exists only for evidence mentioning a child and skips provider confirmations',()=>{
  const data={points:[parent,child],results:[{placeId:child.id,status:'spatial_candidate',candidates:[{parentId:parent.id}]}]};
  assert.equal(buildEvidenceJobs(data,new Map(),[source]).length,1);
  assert.equal(buildEvidenceJobs(data,new Map([[child.id,{status:'child'}]]),[source]).length,0);
  assert.equal(buildEvidenceJobs(data,new Map(),[{...source,text:'只有园的介绍'}]).length,0);
});
test('estimate is based on actual throughput, and HTML scripts cannot become evidence',()=>{
  assert.equal(estimateFinish('2026-10-12T00:00:00Z',10,100,Date.parse('2026-10-12T00:01:00Z')).secondsRemaining,540);
  assert.equal(estimateFinish('2026-10-12T00:00:00Z',0,100),null);
  assert.equal(plainText('<script>伪造内容</script><p>清音亭</p>'),'清音亭');
});
