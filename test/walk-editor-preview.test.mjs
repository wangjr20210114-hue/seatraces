import test from 'node:test';import assert from 'node:assert/strict';
import {renderWalkEditor} from '../public/citywalk-editor.js';
// Minimal DOM adapter drives the actual editor handlers; HTTP is delayed/fails on purpose.
function surface(){
 const nodes=new Map(),messages=[];
 const make=()=>({innerHTML:'',textContent:'',disabled:false,dataset:{},addEventListener(name,fn){this['on'+name]=fn;},contentWindow:{postMessage:message=>messages.push(message)}});
 const root=make();root.querySelector=selector=>{
  const id=selector.slice(1);if(![root,...nodes.values()].some(n=>n.innerHTML.includes('id="'+id+'"')))return null;
  if(!nodes.has(selector))nodes.set(selector,make());return nodes.get(selector);
 };return {root,nodes,messages};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('CityWalk selection stays local, debounces nearby reads and rejects stale verification',async t=>{
 const originalWindow=globalThis.window,originalLocation=globalThis.location;
 globalThis.window={addEventListener(){},removeEventListener(){}};globalThis.location={origin:'http://test.local'};
 const {root,nodes,messages}=surface(),calls=[];
 const points=Array.from({length:100},(_,i)=>({id:'p'+i,name:'地点'+i,lat:31+i%10*0.0001,lng:121+Math.floor(i/10)*0.0001,country:'CN',category:'attraction'}));
 const city={id:'test-city',name:'测试城市',lat:31,lng:121,country:'CN'};
 let finish,disposed=false;
 const api=async(path,body)=>{calls.push({path,body});if(path.startsWith('/api/places?'))return [city];if(path.startsWith('/api/citywalk/catalog/'))return {draftId:'draft',clusters:[{id:'group',name:'片区',members:points,anchor:points[0],number:1,memberCount:100}]};if(path.endsWith('/nearby'))return {items:points};if(path==='/api/citywalk/preview')return new Promise(resolve=>finish=resolve);if(path==='/api/citywalks')return {};throw Error(path);};
 let cleanup;
 try{
  cleanup=await renderWalkEditor({route:{id:'new'},content:root,setTitle(){},api,navigate(){},isCurrent:()=>!disposed,toast(){}});await flush();
  nodes.get('#walk-city-options').onclick({target:{closest:()=>({dataset:{city:'0'}})}});await flush();
  nodes.get('#walk-areas').onclick({target:{closest:()=>({dataset:{area:'group'}})}});await flush();
  const select=id=>nodes.get('#walk-candidates').onclick({target:{closest:()=>({dataset:{place:id}})}});
  const remove=id=>nodes.get('#walk-selected').onclick({target:{closest:()=>({dataset:{remove:id}})}});
  const times=[];
  for(let i=0;i<100;i++){const start=performance.now();select('p'+i);times.push(performance.now()-start);}
  assert.equal(calls.filter(c=>c.path==='/api/citywalk/preview').length,0);
  assert.equal(nodes.get('#walk-count').textContent,'100 个地点');assert.equal(nodes.get('#walk-save').disabled,false);
  assert.ok(messages.at(-1).connections.length>0);assert.match(nodes.get('#walk-route-state').textContent,/连线约/);
  await new Promise(resolve=>setTimeout(resolve,260));assert.equal(calls.filter(c=>c.path.endsWith('/nearby')).length,2);
  const old=nodes.get('#walk-save').onclick();await flush();assert.equal(calls.filter(c=>c.path==='/api/citywalk/preview').length,1);
  remove('p99');finish({route:{status:'verified',distanceM:900,legs:[],blocked:false}});await old;
  assert.equal(nodes.get('#walk-count').textContent,'99 个地点');assert.equal(nodes.get('#walk-save').textContent,'规划步行路线 →','stale response cannot verify edited selection');
  const denied=nodes.get('#walk-save').onclick();await flush();finish({route:{status:'verified',distanceM:15000,blocked:true,warning:true,legs:[]}});await denied;
  assert.equal(nodes.get('#walk-save').disabled,true);assert.match(nodes.get('#walk-route-state').textContent,/达到 15/);
  remove('p98');const unavailable=nodes.get('#walk-save').onclick();await flush();finish({route:{status:'preview',legs:[]}});await unavailable;
  assert.equal(calls.filter(c=>c.path==='/api/citywalks').length,0);assert.equal(nodes.get('#walk-save').textContent,'规划步行路线 →');
  times.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({rapidSelections:100,routeCallsDuringSelection:0,p95Ms:+times[94].toFixed(2),maxMs:+times[99].toFixed(2)}));assert.ok(times[94]<100,'local ordering should not stall input');
 }finally{disposed=true;cleanup?.();globalThis.window=originalWindow;globalThis.location=originalLocation;}
});
