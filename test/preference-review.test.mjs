import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { disagreement, validateAnswers, summarizeReview, renderReview } from '../scripts/lib/preference-review.mjs';
import { saveReview } from '../scripts/lib/preference-review-store.mjs';
import { reviewServer } from '../scripts/serve-preference-review.mjs';

const options=[{key:'x',title:'园林',body:'沿湖慢走',tags:['慢游'],route:''},{key:'y',title:'艺术展',body:'走访展馆',tags:['艺术'],route:''}];
const study={protocolId:'frozen-study',primaryCount:2,tasks:[{id:'a',scenario:'喜欢园林',options},{id:'b',scenario:'喜欢艺术',options},{id:'repeat',scenario:'喜欢园林',options}]};
const protocol={protocolId:study.protocolId,probes:[{taskId:'a',methods:['rule','tower'],preferredKeys:['x','y']},{taskId:'b',methods:['rule','semantic'],preferredKeys:['y','x']},{taskId:'repeat',repeatOf:'a'}]};
const answers=()=>({protocolId:study.protocolId,reviewerId:randomUUID(),responses:[{taskId:'a',order:['x','y'],choice:'first',elapsedMs:4000},{taskId:'b',order:['x','y'],choice:'both',elapsedMs:5000},{taskId:'repeat',order:['y','x'],choice:'second',elapsedMs:3000}]});

test('pair selection requires strict reciprocal disagreement and excludes reused pairs',()=>{
  const a=[{id:'x',score:3},{id:'y',score:2}],b=[{id:'y',score:3},{id:'x',score:2}];
  assert.deepEqual(disagreement(a,b),{pair:'x:y',ids:['x','y']});
  assert.equal(disagreement(a,a),null);assert.equal(disagreement(a,b,new Set(['x:y'])),null);
  assert.equal(disagreement(a,[{id:'y',score:2},{id:'x',score:2}]),null);
});

test('answers reject mismatched protocol, path-like identity, omissions, duplicates, invalid ordering and time',()=>{
  const mutations=[x=>x.protocolId='other',x=>x.reviewerId='../'.repeat(12),x=>x.responses.pop(),x=>x.responses[1]=x.responses[0],x=>x.responses[0]=null,x=>x.responses[0].taskId='unknown',x=>x.responses[0].choice='approve',x=>x.responses[0].order=['x','x'],x=>x.responses[0].order=['x','foreign'],x=>x.responses[0].elapsedMs=Infinity,x=>x.responses[0].elapsedMs=-1,x=>x.responses[0].elapsedMs=86400001];
  for(const mutate of mutations){const a=answers();mutate(a);assert.throws(()=>validateAnswers(study,a));}
  const a=answers();a.email='discard-me';a.responses[0].secret='discard-me';
  assert.equal(JSON.stringify(validateAnswers(study,a)).includes('discard-me'),false);
});

test('summary is independent of displayed left/right order and does not double-count repeats',()=>{
  const a=answers(), first=summarizeReview(study,protocol,a);
  a.responses[0].order.reverse();a.responses[0].choice='second';
  assert.deepEqual(summarizeReview(study,protocol,a),first);
  assert.equal(first.totals['rule vs tower'].tasks,1);assert.equal(first.totals['rule vs tower'].firstMethodWins,1);
  assert.equal(first.totals['rule vs semantic'].both,1);assert.equal(first.repeatAgreements,1);assert.equal(first.repeats,1);
  assert.equal(first.activationAllowed,false);assert.equal(first.diagnosticOnly,true);
  assert.throws(()=>summarizeReview(study,{...protocol,protocolId:'other'},a),/Protocol mismatch/);
});

test('ties, rejection and insufficient information stay separate from method wins',()=>{
  for(const choice of ['both','neither','unsure']){
    const a=answers();a.responses[0].choice=choice;
    const s=summarizeReview(study,protocol,a);
    assert.equal(s.totals['rule vs tower'][choice],1);assert.equal(s.totals['rule vs tower'].firstMethodWins,0);
    assert.equal(s.totals['rule vs tower'].secondMethodWins,0);assert.equal(s.repeatAgreements,0);
  }
});

test('HTML cannot break out of the embedded data script and never includes private protocol',async()=>{
  const client=await readFile(new URL('../scripts/lib/preference-review-client.js',import.meta.url),'utf8');
  const evil=structuredClone(study);evil.tasks[0].options[0].body='</script><script>evil()</script>\u2028';
  const html=renderReview(evil,client);
  assert.equal(html.includes('<script>evil()'),false);assert.equal(html.includes('preferredKeys'),false);assert.equal(html.includes('firstMethodWins'),false);
  assert.match(html,/\\u003c\/script>/);assert.match(client,/el\.textContent = text/);
  assert.equal(html.includes('https://'),false); // Portable artifact has no external requests or tracking.
});

test('local evidence storage is idempotent, strips unknown data, keeps revisions and one reviewer ID',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'seatraces-review-')),url=pathToFileURL(dir+sep),a=answers();
  try{
    const first=await saveReview(url,study,protocol,a);a.ignored='not-saved';
    const second=await saveReview(url,study,protocol,a);assert.equal(first.file,second.file);assert.equal((await readdir(dir)).length,2);
    assert.equal((await readFile(new URL(first.file,url),'utf8')).includes('not-saved'),false);
    a.responses[0].choice='second';const changed=await saveReview(url,study,protocol,a);
    assert.notEqual(changed.file,first.file);assert.equal(changed.reviewerId,first.reviewerId);assert.equal((await readdir(dir)).length,4);
  }finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep+'seatraces-review-'));await rm(dir,{recursive:true,force:true});}
});

function call(port,{method='GET',path='/',host='127.0.0.1:'+port,origin='http://127.0.0.1:'+port,body,contentType='application/json'}={}){
  return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,method,path,headers:{host,origin,'content-type':contentType,...(body===undefined?{}:{'content-length':Buffer.byteLength(body)})}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end(body);});
}
test('review server restricts host/origin, rejects private paths and oversized bodies, and validates before saving',async()=>{
  const saved=[],server=reviewServer({study,html:'<!doctype html>review',save:async a=>saved.push(a)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
  try{
    const page=await call(port);assert.equal(page.status,200);assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);
    assert.equal((await call(port,{path:'/protocol-private.json'})).status,404);
    assert.equal((await call(port,{host:'attacker.example'})).status,403);
    assert.equal((await call(port,{method:'POST',path:'/answers',origin:'https://attacker.example',body:JSON.stringify(answers())})).status,403);
    assert.equal((await call(port,{method:'POST',path:'/answers',body:'{'})).status,400);
    assert.equal((await call(port,{method:'POST',path:'/answers',body:'x'.repeat(65537)})).status,413);
    assert.equal(saved.length,0);
    assert.equal((await call(port,{method:'POST',path:'/answers',body:JSON.stringify(answers())})).status,200);assert.equal(saved.length,1);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('offline CLIs reject production or unsupported flags before accessing data',()=>{
  for(const name of ['prepare-preference-review.mjs','serve-preference-review.mjs','import-preference-review.mjs']){
    const r=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/'+name,import.meta.url)),'--local','--activate'],{encoding:'utf8'});
    assert.equal(r.status,1);assert.match(r.stderr,/Only --local|Use --local/);
    const prod=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/'+name,import.meta.url)),'--local',...(name==='import-preference-review.mjs'?['never-read.json']:[])],{encoding:'utf8',env:{...process.env,NODE_ENV:'production'}});
    assert.equal(prod.status,1);assert.match(prod.stderr,/Only --local|Use --local/);
  }
});
