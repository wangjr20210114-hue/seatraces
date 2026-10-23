/* 验证人工分级评审。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {request} from 'node:http';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateGradedAnswers,summarizeGraded,renderGradedReview,compareGraded} from '../scripts/lib/graded-preference-review.mjs';
import {gradedReviewServer} from '../scripts/serve-graded-preference-review.mjs';
const study={protocolId:'fixed',primaryCount:2,tasks:[{id:'a',body:'公园'},{id:'b',body:'街区'},{id:'c',body:'公园'}]},protocol={protocolId:'fixed',probes:[{taskId:'a',group:'g',stratum:'random'},{taskId:'b',group:'g',stratum:'disagreement'},{taskId:'c',repeatOf:'a'}]};
const answers=()=>({protocolId:'fixed',reviewerId:randomUUID(),responses:study.tasks.map(t=>({taskId:t.id,ratings:{read:'yes',save:'no',adopt:'unknown'},elapsedMs:1000}))});
test('separate dimensions, unknown and repeats retain their meaning',()=>{
 const a=answers(),report=summarizeGraded(study,protocol,[a]);
 assert.equal(report.strata.random.read.yes,1);assert.equal(report.strata.random.adopt.unknown,1);assert.equal(report.strata.random.adopt.no,0);
 assert.equal(report.tasks.length,2);assert.equal(report.repeatComparisons,3);assert.equal(report.repeatAgreements,3);
 assert.equal(report.activationAllowed,false);assert.equal(summarizeGraded(study,protocol,[]).status,'awaiting_reviews');
 const b=structuredClone(a);b.reviewerId=b.reviewerId.toUpperCase();assert.throws(()=>summarizeGraded(study,protocol,[a,b]),/one final/);
});
test('malformed, incomplete, duplicated and foreign answers are rejected',()=>{
 for(const mutate of [a=>a.protocolId='other',a=>a.reviewerId='../secret',a=>a.responses.pop(),a=>a.responses[1]=a.responses[0],a=>a.responses[0]=null,a=>delete a.responses[0].ratings.save,a=>a.responses[0].ratings.save='approve',a=>a.responses[0].elapsedMs=-1,a=>a.responses[0].elapsedMs=Infinity]){const a=answers();mutate(a);assert.throws(()=>validateGradedAnswers(study,a));}
 const a=answers();a.password='strip-me';a.responses[0].email='strip-me';assert.equal(JSON.stringify(validateGradedAnswers(study,a)).includes('strip-me'),false);
});
test('frozen model comparison excludes unknown/repeats and never invents a result for empty groups',()=>{
 const p=structuredClone(protocol);p.probes[1].stratum='random';
 const frozen={protocolId:'fixed',activationAllowed:false,predictions:[{taskId:'a',scores:{cosine:2,fineRule:2,lightgbm:1,bgeSmall:1}},{taskId:'b',scores:{cosine:1,fineRule:1,lightgbm:2,bgeSmall:2}}]};
 const a=answers();a.responses[0].ratings.read='no';a.responses[1].ratings.read='yes';
 const r=compareGraded(study,p,frozen,[a]);const read=r.results.find(r=>r.dimension==='read'&&r.stratum==='random');
 assert.equal(read.groups,1);assert.equal(read.ndcgAt3.lightgbm,1);assert.ok(read.ndcgAt3.cosine<1);
 const adopt=r.results.find(r=>r.dimension==='adopt'&&r.stratum==='random');assert.equal(adopt.unknownExcluded,2);assert.equal(adopt.ndcgAt3.lightgbm,null);
 assert.equal(compareGraded(study,p,frozen,[]).results.every(r=>Object.values(r.ndcgAt3).every(v=>v===null)),true);
 frozen.predictions.pop();assert.throws(()=>compareGraded(study,p,frozen,[a]),/mismatch/);
});
test('public artifact has no scoring protocol or remote resources and escapes injected HTML',async()=>{
 const client=await readFile(new URL('../scripts/lib/graded-preference-client.js',import.meta.url),'utf8');
 const bad=structuredClone(study);bad.tasks[0].body='</script><script>bad()</script>';
 const html=renderGradedReview(bad,client);assert.equal(html.includes('<script>bad()'),false);assert.equal(/https?:\/\//.test(html),false);assert.equal(html.includes('sourceRevision'),false);
 assert.match(client,/\.textContent=task\[k\]/);assert.match(html,/connect-src 'none'/);
});
test('readonly local server never exposes private evidence or accepts uploads',async()=>{
 const server=gradedReviewServer('<!doctype html>fixture');await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port;
 try{assert.equal((await fetch(url)).status,200);assert.equal((await fetch(url+'/protocol-private.json')).status,404);assert.equal((await fetch(url,{method:'POST',body:'private'})).status,404);
  const status=await new Promise((resolve,reject)=>{const req=request(url,{headers:{host:'attacker.example'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});assert.equal(status,403);}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('bounded aggregation accepts 1000 independent fixture reviewers and rejects overflow',()=>{
 const inputs=Array.from({length:1000},answers),report=summarizeGraded(study,protocol,inputs);
 assert.equal(report.reviewerCount,1000);assert.equal(report.strata.random.read.yes,1000);
 assert.equal(report.repeatComparisons,3000);assert.throws(()=>summarizeGraded(study,protocol,[...inputs,answers()]),/bound/);
});
test('offline commands reject production before reading input or opening database',()=>{
 for(const script of ['export-ranking-diagnostic.mjs','prepare-graded-preference-review.mjs','serve-graded-preference-review.mjs','import-graded-preference-review.mjs']){
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/'+script,import.meta.url)),'--local'],{encoding:'utf8',env:{...process.env,NODE_ENV:'production'}});
  assert.equal(result.status,1);assert.match(result.stderr,/Only --local|Use --local/);
 }
});
