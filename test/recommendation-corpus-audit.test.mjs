import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {auditCorpus,matchesGeneratedPost} from '../scripts/lib/recommendation-corpus-audit.mjs';

const place=(id,name,extra={})=>({id,name,category:'attraction',...extra});
const post=(id,tags,stops)=>({id,title:'散步',body:'10月1日。开头\n\n内容',tags,snapshot:stops?{days:[{stops}]}:{}});

test('missing keyword evidence is only a diagnostic flag, not a false label',()=>{
  const p=post('a',['人文','人文'],[place('temple','北京孔庙')]),before=structuredClone(p);
  const r=auditCorpus([p]);assert.equal(r.topicEvidence['人文'].posts,1);assert.equal(r.topicEvidence['人文'].noRecognizedRouteEvidence,1);
  assert.equal(r.automaticRelabeling,false);assert.equal(r.activationAllowed,false);assert.deepEqual(p,before);
});
test('route traits support a topic, while missing routes stay separate',()=>{
  const r=auditCorpus([post('a',['园林'],[place('a','静园',{traits:{leisure:'garden'}})]),post('b',['园林'])]);
  assert.equal(r.total,2);assert.equal(r.withRoute,1);assert.equal(r.withoutRoute,1);assert.equal(r.topicEvidence['园林'].routeEvidence,1);
  assert.equal(r.topicEvidence['园林'].noRecognizedRouteEvidence,0);assert.equal(r.stopsWithTraits,1);assert.equal(r.routeVariants,1);
});
test('source-replay evidence distinguishes lost selection triggers from unknown generator state',()=>{
  const stops=[place('a','街角'),place('b','桥边'),place('c','美术馆')],p=post('a',['艺术'],stops.slice(0,2));
  const context={generated:{...p,style:'艺术散步'},keywords:['美术']};
  const options={routes:[{id:'route',stops}],generatorContexts:new Map([['a',context]])};
  const r=auditCorpus([p],options);assert.equal(r.generation.verifiedPosts,1);assert.equal(r.generation.missingSelectionTrigger,1);
  assert.deepEqual(r.generation.examples[0].omittedMatchingStops,['美术馆']);
  const modified={...p,title:'更改后的标题'};assert.equal(auditCorpus([modified],options).generation.missingSelectionTrigger,0);
  assert.equal(auditCorpus([modified],options).generation.unverifiedPosts,1);
  assert.equal(auditCorpus([p],{...options,routes:[...options.routes,...options.routes]}).generation.uniqueSourceRoute,0);
});
test('replay only ignores opening date, not route, tags or later body edits',()=>{
  const p=post('a',['艺术'],[place('a','美术馆')]);
  assert.equal(matchesGeneratedPost(p,{...p,body:'10月2日。开头\n\n内容'}),true);
  assert.equal(matchesGeneratedPost(p,{...p,body:'10月2日。改过的开头\n\n内容'}),false);
  assert.equal(matchesGeneratedPost(p,{...p,body:'10月1日。开头\n\n另一个内容'}),false);
  assert.equal(matchesGeneratedPost(p,{...p,tags:['自然']}),false);
  assert.equal(matchesGeneratedPost(p,{...p,snapshot:{}}),false);
});
test('audit rejects duplicate identifiers, excessive input and production CLI usage',()=>{
  const p=post('a',[]);assert.throws(()=>auditCorpus([p,p]),/unique/);
  assert.throws(()=>auditCorpus(Array.from({length:1001},(_,i)=>post(String(i),[]))),/1000/);
  for(const args of [[],['--real'],['--local','--activate']]){
    const r=spawnSync(process.execPath,['scripts/audit-recommendation-corpus.mjs',...args],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/Only --local/);
  }
  const r=spawnSync(process.execPath,['scripts/audit-recommendation-corpus.mjs','--local'],{encoding:'utf8',env:{...process.env,NODE_ENV:'production'}});
  assert.notEqual(r.status,0);assert.match(r.stderr,/Only --local/);
});
