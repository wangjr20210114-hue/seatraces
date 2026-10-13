import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteSelection, amapEndpointParams, routingProvider } from '../server/route-selection.mjs';
import { googleRouteRequest } from '../server/google-maps.mjs';
import { chooseRoutingCandidate, selectedRouteTokens } from '../public/route-selection.js';
import { navigationUrl } from '../public/navigation.js';
import { toGcj } from '../public/coordinates.js';

// All provider references in this file are synthetic contract fixtures.
const a={id:'osm:node/1',name:'测试起点',country:'CN',lat:31.21,lng:121.41};
const b={id:'osm:node/2',name:'测试终点',country:'CN',lat:31.23,lng:121.45};
const ref={provider:'amap',id:'TEST_ORIGIN',location:'121.420100,31.215100'};
const other={provider:'amap',id:'TEST_DESTINATION',location:'121.460200,31.235200'};
const expires=Date.UTC(2026,9,11,0,15),clock=Date.UTC(2026,9,11);

test('candidate proof binds owner, source POI and routing provider',()=>{
  const service=createRouteSelection({now:()=>clock});
  const issued=service.issue('user-a',a.id,ref);
  assert.deepEqual(service.resolve(issued.routeToken,'user-a',a.id,'amap'),ref);
  for(const args of [['user-b',a.id,'amap'],['user-a',b.id,'amap'],['user-a',a.id,'google']])
    assert.throws(()=>service.resolve(issued.routeToken,...args),{status:409});
  assert.equal(Date.parse(issued.expiresAt),expires);
});

test('modified, oversized and restarted-process proofs cannot choose an endpoint',()=>{
  const service=createRouteSelection({now:()=>clock}),token=service.issue('u',a.id,ref).routeToken;
  const [payload,signature]=token.split('.'),data=JSON.parse(Buffer.from(payload,'base64url'));
  data.ref.location='120.000000,30.000000';
  const forged=Buffer.from(JSON.stringify(data)).toString('base64url')+'.'+signature;
  for(const input of [forged,'x'.repeat(3000),'bad.token','',null])assert.throws(()=>service.resolve(input,'u',a.id,'amap'),{status:409});
  assert.throws(()=>createRouteSelection({now:()=>clock}).resolve(token,'u',a.id,'amap'),{status:409});
});

test('expired candidate fails at its boundary and invalid locations are never issued',()=>{
  let now=clock;const service=createRouteSelection({now:()=>now});
  const token=service.issue('u',a.id,ref).routeToken;
  now=expires-1;assert.equal(service.resolve(token,'u',a.id,'amap').id,ref.id);
  now=expires;assert.throws(()=>service.resolve(token,'u',a.id,'amap'),{status:409});
  for(const location of ['NaN,31','999,31','120,91','120,31,32','','120.1234567,31'])
    assert.throws(()=>service.issue('u',a.id,{...ref,location}),{status:409});
});

test('selected Amap coordinates and IDs reach walking and driving unchanged',()=>{
  for(const mode of ['walking','driving']){
    assert.deepEqual(amapEndpointParams(a,b,mode,{from:ref,to:other}),{
      origin:ref.location,destination:other.location,origin_id:ref.id,destination_id:other.id});
  }
  assert.deepEqual(amapEndpointParams(a,b,'walking'),{origin:toGcj(a),destination:toGcj(b)});
  assert.equal(a.lat,31.21);assert.equal(a.lng,121.41);
});

test('transit uses paired POI IDs; a single candidate and cycling use selected coordinates',()=>{
  assert.deepEqual(amapEndpointParams(a,b,'transit',{from:ref,to:other}),{
    origin:ref.location,destination:other.location,originpoi:ref.id,destinationpoi:other.id});
  assert.deepEqual(amapEndpointParams(a,b,'transit',{from:ref}),{origin:ref.location,destination:toGcj(b)});
  assert.deepEqual(amapEndpointParams(a,b,'cycling',{from:ref,to:other}),{origin:ref.location,destination:other.location});
  assert.throws(()=>amapEndpointParams(a,b,'walking',{from:{provider:'google',id:'TEST_GOOGLE'}}),{status:409});
});

test('Google selection retains only provider ID and Routes receives a place-ID waypoint',()=>{
  const jp={...a,country:'JP',lat:35.65,lng:139.74},service=createRouteSelection({now:()=>clock});
  const token=service.issue('u',jp.id,{provider:'google',id:'TEST_GOOGLE_ORIGIN',name:'discarded',address:'discarded'}).routeToken;
  const picked=service.resolve(token,'u',jp.id,'google');
  assert.deepEqual(picked,{provider:'google',id:'TEST_GOOGLE_ORIGIN'});
  const body=googleRouteRequest(jp,{...jp,id:b.id,lat:35.7},{selections:{from:picked}});
  assert.deepEqual(body.origin,{placeId:picked.id});
  assert.equal(body.destination.location.latLng.latitude,35.7);
  assert.equal(routingProvider(jp,b),'google');
  assert.throws(()=>googleRouteRequest(jp,jp,{selections:{from:ref}}),{status:409});
});

test('frontend confirmation is immutable and only sends proof for explicitly selected endpoints',()=>{
  const proof=createRouteSelection({now:()=>clock}).issue('u',a.id,ref);
  const chosen=chooseRoutingCandidate(a,{...proof,id:ref.id,name:'测试地图候选'},'amap');
  assert.equal(a.routingChoice,undefined);assert.equal(chosen.id,a.id);assert.equal(chosen.lat,a.lat);
  assert.deepEqual(selectedRouteTokens(chosen,b,clock),{fromMatchToken:proof.routeToken});
  assert.deepEqual(selectedRouteTokens(a,b,clock),{});
  assert.throws(()=>selectedRouteTokens(chosen,b,expires),/过期/);
  assert.throws(()=>selectedRouteTokens(chosen,{...b,country:'JP'},clock),/范围不一致/);
  assert.throws(()=>chooseRoutingCandidate(a,{name:'No route proof'},'amap'),/缺少/);
});

test('confirmation through proof resolution constructs provider request without changing OSM data',()=>{
  const service=createRouteSelection({now:()=>clock}),original=structuredClone([a,b]);
  const selected=chooseRoutingCandidate(a,{id:ref.id,name:'测试候选',...service.issue('user',a.id,ref)},'amap');
  const request=selectedRouteTokens(selected,b,clock);
  const resolved=service.resolve(request.fromMatchToken,'user',a.id,routingProvider(a,b));
  assert.equal(amapEndpointParams(a,b,'walking',{from:resolved}).origin,ref.location);
  assert.deepEqual([a,b],original);
});

test('whole-trip map links preserve selected points while transfer links use their own stops',()=>{
  const url=new URL(navigationUrl({from:a,to:b,mode:'walking',mainland:true,convertToGcj:toGcj,selections:{from:ref,to:other}}));
  assert.equal(url.searchParams.get('from'),ref.location+',起点');assert.equal(url.searchParams.get('to'),other.location+',终点');
  const selections={from:{provider:'google',id:'TEST_ORIGIN'},to:{provider:'google',id:'TEST_DESTINATION'}};
  const full=new URL(navigationUrl({from:a,to:b,mode:'transit',selections}));
  assert.equal(full.searchParams.get('origin_place_id'),'TEST_ORIGIN');assert.equal(full.searchParams.get('destination_place_id'),'TEST_DESTINATION');
  const leg={mode:'walk',start:[35,139],end:[35.01,139.01]};
  const part=new URL(navigationUrl({from:a,to:b,mode:'transit',leg,selections}));
  assert.equal(part.searchParams.get('origin'),'35,139');assert.equal(part.searchParams.has('origin_place_id'),false);
  const mainlandPart=new URL(navigationUrl({from:a,to:b,mode:'transit',leg:{...leg,start:[31.2,121.4],end:[31.3,121.5]},mainland:true,convertToGcj:toGcj,selections:{from:ref}}));
  assert.equal(mainlandPart.searchParams.get('from'),toGcj({lat:31.2,lng:121.4})+',起点');
});
