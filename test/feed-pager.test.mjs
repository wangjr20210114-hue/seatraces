/* 验证信息流分页加载。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeedPager } from '../public/feed-pager.js';
const response=(ids,cursor=null)=>({items:ids.map(id=>({id,title:id})),nextCursor:cursor,requestId:'request'});
test('append exhausts a frozen pool before starting a new pool with exclusions',async()=>{
 const calls=[],replies=[response(['a','b'],'session:2'),response(['b','c']),response(['d']),response([])];let state;
 const pager=createFeedPager({api:async(...args)=>{calls.push(args);return replies.shift();},onChange:s=>{state=s;}});
 await pager.reset();await pager.loadMore();assert.deepEqual(state.items.map(p=>p.id),['a','b','c']);
 assert.ok(calls[1][0].includes('cursor=session%3A2'));
 await pager.loadMore();assert.equal(calls[2][0],'/api/social/feed');assert.deepEqual(calls[2][1].exclude,['a','b','c']);
 assert.deepEqual(state.items.map(p=>p.id),['a','b','c','d']);await pager.loadMore();assert.ok(state.exhausted);
 await pager.loadMore();assert.equal(calls.length,4);pager.dispose();
});
test('scroll bursts coalesce, failures preserve the cursor, stale filters never append',async()=>{
 const pending=[],calls=[];let state;
 const pager=createFeedPager({api:(...args)=>{calls.push(args);return new Promise((resolve,reject)=>pending.push({resolve,reject}));},onChange:s=>{state=s;}});
 const first=pager.reset();await Promise.all(Array.from({length:100},()=>pager.loadMore()));assert.equal(calls.length,1);
 pending.shift().resolve(response(['a'],'session:1'));await first;
 const next=pager.loadMore();pending.shift().reject(Error('断网'));await next;assert.equal(state.cursor,'session:1');assert.deepEqual(state.items.map(p=>p.id),['a']);
 const retry=pager.loadMore();assert.equal(calls[1][0],calls[2][0]);
 const changed=pager.reset({scope:'following',q:'园林'});pending.shift().resolve(response(['stale']));await retry;
 pending.shift().resolve(response(['following']));await changed;assert.deepEqual(state.items.map(p=>p.id),['following']);assert.ok(state.exhausted);
 pager.dispose();await pager.loadMore();assert.equal(calls.length,4);
});
test('600-card session ceiling keeps exclusion payload bounded without dropping visible records',async()=>{
 let n=0,state;
 const pager=createFeedPager({api:async()=>response(Array.from({length:12},()=>String(n++))),onChange:s=>{state=s;}});
 await pager.reset();for(let i=0;i<100;i++)await pager.loadMore();assert.equal(state.items.length,600);assert.equal(n,600);assert.ok(state.exhausted);pager.dispose();
});
test('new interest preserves visible cards but immediately bypasses the old pool on the next append',async()=>{
 const calls=[];let state;const replies=[response(['a','b'],'old:2'),response(['c'],'new:1')];
 const pager=createFeedPager({api:async(...args)=>{calls.push(args);return replies.shift();},context:()=>({city:'上海'}),onChange:s=>state=s});
 await pager.reset();pager.interestChanged();assert.deepEqual(state.items.map(p=>p.id),['a','b']);
 await pager.loadMore();assert.equal(calls[1][0],'/api/social/feed');assert.deepEqual(calls[1][1].exclude,['a','b']);assert.equal(calls[1][1].city,'上海');
 assert.deepEqual(state.items.map(p=>p.id),['a','b','c']);pager.dispose();
});
test('interest changes during an in-flight request cannot restore a stale cursor',async()=>{
 let finish,state;const pager=createFeedPager({api:()=>new Promise(r=>finish=r),onChange:s=>state=s});
 const request=pager.reset();pager.interestChanged();finish(response(['a'],'old:1'));await request;
 assert.equal(state.cursor,null);assert.deepEqual(state.items.map(p=>p.id),['a']);pager.dispose();
});
