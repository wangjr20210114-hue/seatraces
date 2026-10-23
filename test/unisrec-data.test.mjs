/* 验证UniSRec 序列数据。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {sequenceInputs} from '../scripts/lib/unisrec-data.mjs';
import {profileText,week} from '../scripts/lib/offline-semantic.mjs';
const v=Array(96).fill(0);v[0]=1;
const bge=Array(512).fill(0);bge[0]=1;
const sample=(postId,at,label=1,userId='u')=>({postId,at,label,userId,user:v,item:v,weight:1});
const prepare=(samples,split={train:samples,validation:[],test:[]})=>sequenceInputs(samples,new Map(samples.map(s=>[s.postId,bge])),new Map([[profileText(v),bge]]),split);

test('sequence input excludes current, future, same-window and other-user outcomes',()=>{
  const rows=[sample('early',0),sample('negative',1,0),sample('other',2,1,'other'),sample('exact-window',week),sample('current',week+1),sample('future',week*2)];
  const before=structuredClone(rows),out=prepare(rows),current=out.rows.find(r=>r.postId==='current');
  assert.deepEqual(current.history.map(i=>out.posts[i].id),['early']);
  assert.ok(current.historyWindowEnds.every(t=>t<current.at));
  const changed=prepare(rows.map(r=>r.postId==='current'||r.postId==='future'?{...r,label:0}:r));
  assert.deepEqual(changed.rows.find(r=>r.postId==='current').history,current.history);
  assert.deepEqual(rows,before);
});
test('sequence inputs retain explicit preference for cold starts and enforce order and history bounds',()=>{
  const rows=Array.from({length:25},(_,i)=>sample(String(i),i*1000));rows.push(sample('last',week+25000));
  const out=prepare([...rows].reverse()),last=out.rows.at(-1);
  assert.equal(last.history.length,20);assert.equal(out.profiles[0].features.length,608);
  assert.equal(out.rows[0].history.length,0);assert.equal(out.rows[0].profile,0);
  assert.deepEqual(last.history.map(i=>out.posts[i].id),Array.from({length:20},(_,i)=>String(i+5)));
  assert.equal(prepare([sample('old',0),sample('late',31*86400000)]).rows.at(-1).history.length,0);
});
test('historical features and partition integrity are checked; CLI rejects activation and production',()=>{
  const a=sample('a',0),b={...sample('a',week*2),item:[0,1,...Array(94).fill(0)]};
  assert.throws(()=>prepare([a,b]),/features changed/);
  assert.throws(()=>prepare([a],{train:[a],validation:[a],test:[]}),/Overlapping/);
  assert.throws(()=>sequenceInputs([a],new Map(),new Map(),{train:[a],validation:[],test:[]}),/Missing cached/);
  for(const args of [[],['--real'],['--local','--activate']]){
    const r=spawnSync(process.execPath,['scripts/export-unisrec-experiment.mjs',...args],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/Only --local/);
  }
  const production=spawnSync(process.execPath,['scripts/export-unisrec-experiment.mjs','--local'],{encoding:'utf8',env:{...process.env,NODE_ENV:'production'}});
  assert.notEqual(production.status,0);assert.match(production.stderr,/Only --local/);
});
