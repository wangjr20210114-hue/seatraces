import test from 'node:test';
import assert from 'node:assert/strict';
import {specs,formatText,historyVector,cosine} from '../scripts/experiment-travel-embeddings.mjs';
test('each pretrained encoder receives the documented prefix and pooling',()=>{
  const query='为这个句子生成表示以用于检索相关文章：旅行内容偏好：园林';
  assert.equal(formatText(query,true,specs['bge-base']),query);
  assert.equal(formatText(query,true,specs['e5-small']),'query: 旅行内容偏好：园林');
  assert.equal(formatText('苏州漫步',false,specs['e5-small']),'passage: 苏州漫步');
  assert.equal(formatText('苏州漫步',false,specs['bge-base']),'苏州漫步');
  assert.equal(specs['bge-base'].pooling,'cls');assert.equal(specs['e5-small'].pooling,'mean');
});
test('history is time bounded; current labels cannot change features',()=>{
  const row={at:20*86400000,profile:0,history:[0],historyWindowEnds:[15*86400000],label:0};
  const items=[[0,1]],profiles=[[1,0]],a=historyVector(row,items,profiles);
  assert.deepEqual(a,historyVector({...row,label:1,weight:999},items,profiles));
  assert.ok(Math.abs(Math.hypot(...a)-1)<1e-9);assert.ok(a[0]>a[1]&&a[1]>0);
  assert.deepEqual(historyVector({...row,history:[],historyWindowEnds:[]},items,profiles),[1,0]);
  assert.throws(()=>historyVector({...row,historyWindowEnds:[row.at]},items,profiles),/Future/);
  assert.equal(cosine([2,0],[4,0]),1);
});
