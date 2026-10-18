import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPublicTestPayload,liveAgentQuestions} from '../scripts/lib/agent-live-payload.mjs';
import {knowledge,capabilities} from '../server/agent/catalog.mjs';
test('live acceptance sends only fixed questions and exact code-owned public documents',()=>{
  const {id,title,content}=knowledge[0],input={question:liveAgentQuestions[0],documents:[{id,title,content}]};
  assert.equal(assertPublicTestPayload(input),'public_software_knowledge');
  assert.throws(()=>assertPublicTestPayload({...input,userId:'private-user'}),/outside/);
  assert.throws(()=>assertPublicTestPayload({...input,question:'real conversation content'}),/outside/);
  assert.throws(()=>assertPublicTestPayload({...input,documents:[{id,title,content:content+' private note'}]}),/outside/);
  assert.throws(()=>assertPublicTestPayload({...input,documents:[{id,title,content,token:'secret'}]}),/outside/);
});
test('classification and brief replies reject account context and arbitrary capabilities',()=>{
  const input={text:liveAgentQuestions.at(-1),capabilities,knowledgeTitles:[]};
  assert.equal(assertPublicTestPayload(input),'public_capabilities');
  assert.equal(assertPublicTestPayload({text:input.text}),'synthetic_question');
  assert.throws(()=>assertPublicTestPayload({...input,capabilities:[...capabilities,{id:'shell'}]}),/outside/);
  assert.throws(()=>assertPublicTestPayload({...input,knowledgeTitles:['private record']}),/outside/);
  assert.throws(()=>assertPublicTestPayload({text:input.text,history:['real data']}),/outside/);
});
