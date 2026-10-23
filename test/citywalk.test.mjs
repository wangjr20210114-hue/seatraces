/* 验证CityWalk 规划与保存。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import { orderWalk, routeMetres } from '../public/citywalk-route.js';
import { selectedWalk, installCityWalkRoutes } from '../server/services/citywalk-service.mjs';

const points = [{ id: 'a', name: 'A', lat: 31, lng: 121 }, { id: 'b', name: 'B', lat: 31.01, lng: 121.01 }, { id: 'c', name: 'C', lat: 31, lng: 121.01 }, { id: 'd', name: 'D', lat: 31.01, lng: 121 }];
const city = { id: 'city-test', name: '测试城市', country: 'CN', lat: 31, lng: 121 };
const catalog = { clusters: [{ id: 'area', members: points }] };
test('CityWalk ordering keeps every selected sight and chosen start while shortening a crossing route', () => {
  const ordered = orderWalk(points, 'a');
  assert.equal(ordered[0].id, 'a'); assert.equal(new Set(ordered.map(p => p.id)).size, 4);
  assert.ok(routeMetres(ordered) < routeMetres(points));
  const fromB = orderWalk(points, 'b'); assert.equal(fromB[0].id, 'b');
  assert.equal(orderWalk([...points, points[0]]).length, 4);
  assert.throws(() => orderWalk([{ id: 'bad', lat: NaN, lng: 1 }]));
});
test('CityWalk selection rejects invented IDs and out-of-scope sights; uses server coordinates', () => {
  const input = { clusterIds: ['area'], stopIds: ['a', 'b'], startId: 'a' };
  assert.equal(selectedWalk({ city, catalog }, input)[0].lat, 31);
  assert.throws(() => selectedWalk({ city, catalog }, { ...input, stopIds: ['a', 'fake'] }));
  assert.throws(() => selectedWalk({ city, catalog }, { ...input, clusterIds: ['fake'] }));
  assert.throws(() => selectedWalk({ city, catalog }, { ...input, stopIds: ['a', 'a'] }));
});
test('PostgreSQL CityWalk preserves editable snapshots and rejects stale drafts', {skip:process.env.TEST_CITYWALK!=='1',timeout:20000}, async()=>{
 const f=await iterationFixture({schemas:['citywalk-schema.sql','citywalk-expansion-schema.sql']});
 try{
  await f.query('CREATE TABLE places(id text,name text,country text,province text,lat double precision,lng double precision,timezone text,category text)');
  await f.query("INSERT INTO places VALUES($1,$2,'CN','',31,121,'Asia/Shanghai','city')",[city.id,city.name]);
  installCityWalkRoutes(f.app,{...f,loadCity:async()=>({city,...catalog}),verify:async()=>({status:'verified',distanceM:3000,legs:[],warning:false,blocked:false})});await f.start();
  let draft;for(let i=0;i<50;i++){const r=await f.request('/api/citywalk/catalog/'+city.id,{user:'user'});if(r.status===200){draft=r.data;break;}await new Promise(r=>setTimeout(r,10));}assert.ok(draft?.draftId);
  const input={id:randomUUID(),draftId:draft.draftId,title:'snapshot route',clusterIds:['area'],stopIds:['a','b','c','d'],startId:'a'};
  assert.equal((await f.request('/api/citywalks',{user:'user',body:input})).status,200);
  await f.query('UPDATE citywalk_drafts SET catalog=$2 WHERE id=$1',[draft.draftId,JSON.stringify({clusters:[{id:'area',members:[points[0]]}]})]);
  const updated=await f.request('/api/citywalks/'+input.id,{user:'user',method:'PUT',body:{...input,startId:'c',version:1}});
  assert.equal(updated.status,200);assert.equal(updated.data.stops[0].id,'c');assert.equal(updated.data.version,2);
  await f.query("UPDATE citywalk_drafts SET expires_at=now()-interval '1 second' WHERE id=$1",[draft.draftId]);
  assert.equal((await f.request('/api/citywalks',{user:'user',body:{...input,id:randomUUID()}})).status,410);
 }finally{await f.close();}
});
