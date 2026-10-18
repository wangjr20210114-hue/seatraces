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
