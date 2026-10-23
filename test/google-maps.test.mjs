/* 验证Google 地图请求与结果转换。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { googleRouteRequest, googleAlternatives, googleDuration, googlePlaceRequest, googlePlaceCandidates, GOOGLE_ROUTE_MASK } from '../server/google-maps.mjs';
import { departureInstant, placeTimeZone } from '../public/travel-time.js';
import { walkingGeometry } from '../public/navigation.js';

const point=(lat,lng)=>({latLng:{latitude:lat,longitude:lng}});
const walk=(name='沿样本道路前进',from=[135.76,35.00],to=[135.761,35.001])=>({travelMode:'WALK',distanceMeters:100,staticDuration:'80s',navigationInstruction:{instructions:name},startLocation:point(from[1],from[0]),endLocation:point(to[1],to[0]),polyline:{geoJsonLinestring:{type:'LineString',coordinates:[from,to]}}});
const ride=(name='样本线',vehicle='SUBWAY')=>({...walk(),travelMode:'TRANSIT',distanceMeters:1000,staticDuration:'300s',transitDetails:{
  stopDetails:{departureStop:{name:'样本站 A',location:point(35,135.76)},arrivalStop:{name:'样本站 B',location:point(35.001,135.761)},departureTime:'2026-10-12T00:10:00Z',arrivalTime:'2026-10-12T00:15:00Z'},
  transitLine:{nameShort:name,vehicle:{type:vehicle},agencies:[{name:'示例运营方',uri:'https://example.com/'}]},
  localizedValues:{departureTime:{time:{text:'09:10'},timeZone:'Asia/Tokyo'},arrivalTime:{time:{text:'09:15'},timeZone:'Asia/Tokyo'}},stopCount:2}});
const response=(steps,extra={})=>({routes:[{duration:'1800s',distanceMeters:2300,legs:[{steps}],...extra}]});
const japan={name:'样本 A',lat:35,lng:135.76,country:'JP'},destination={...japan,lng:135.8};

test('Google walking steps form one leg and retain overseas WGS84 coordinates',()=>{
  const a=googleAlternatives(response([walk(),walk('右转',[135.761,35.001],[135.762,35.002])]),'walking')[0];
  assert.equal(a.segments.length,1);assert.equal(a.segments[0].steps.length,2);
  assert.deepEqual(a.segments[0].start,[35,135.76]);assert.deepEqual(a.segments[0].end,[35.002,135.762]);
  assert.ok(walkingGeometry(a.segments[0]));assert.equal(a.minutes,30);
});
test('Google transit preserves each boarding and nested walking turns',()=>{
  const a=googleAlternatives(response([walk(),walk(),ride(),walk(),ride('样本巴士','BUS'),walk()]),'transit')[0];
  assert.deepEqual(a.segments.map(s=>s.mode),['walk','metro','walk','bus','walk']);
  assert.equal(a.transferCount,1);assert.equal(a.walkingMeters,400);assert.equal(a.segments[0].steps.length,2);
  assert.equal(a.segments[1].departureLocal,'09:10');assert.equal(a.segments[1].departureTimeZone,'Asia/Tokyo');
  assert.equal(a.segments[1].boarding,'样本站 A');assert.equal(a.segments[1].stopCount,2);
});
test('two adjacent metro boardings remain distinct transfer legs',()=>{
  const a=googleAlternatives(response([ride('一号样本'),ride('二号样本')]),'transit')[0];
  assert.equal(a.segments.length,2);assert.equal(a.transferCount,1);
});
test('ferry and tram are retained and stops can survive missing geometry',()=>{
  const r=ride('渡轮样本','FERRY');delete r.polyline;
  const a=googleAlternatives(response([r,ride('电车样本','TRAM')]),'transit')[0];
  assert.deepEqual(a.segments.map(s=>s.mode),['ferry','tram']);assert.equal(a.hasCompleteGeometry,false);
  assert.deepEqual(a.segments[0].start,[35,135.76]);assert.deepEqual(a.segments[0].polyline,[]);
});
test('missing, malformed and discontinuous geometry cannot enable walking guidance',()=>{
  const broken=walk();broken.polyline.geoJsonLinestring.coordinates[1]=[999,35];
  const a=googleAlternatives(response([walk(),broken,walk()]),'walking')[0];
  assert.equal(a.hasCompleteGeometry,false);assert.equal(walkingGeometry(a.segments[0]),null);
  assert.deepEqual(a.segments[0].steps[1].polyline,[]);
});
test('missing times remain unknown; incomplete transit steps are not successful routes',()=>{
  const w=walk();delete w.staticDuration;
  const a=googleAlternatives(response([w],{duration:undefined}),'walking')[0];
  assert.equal(a.minutes,null);assert.equal(a.segments[0].minutes,null);
  assert.deepEqual(googleAlternatives(response([{travelMode:'UNSPECIFIED'}]),'transit'),[]);
  assert.deepEqual(googleAlternatives({routes:[{legs:[{steps:[]}]}]},'transit'),[]);
  assert.equal(googleDuration('0s'),0);assert.equal(googleDuration('1.5s'),1.5);assert.equal(googleDuration('-1s'),null);
});
test('return warnings and distinguish fastest versus few transfers',()=>{
  const a=response([ride('直达')],{duration:'900s',warnings:['供应商测试提示']}).routes[0];
  const b=response([ride('换乘一'),ride('换乘二')],{duration:'600s'}).routes[0];
  assert.equal(googleAlternatives({routes:[a,b]},'transit','fastest')[0].durationSeconds,600);
  const few=googleAlternatives({routes:[a,b]},'transit','fewTransfers')[0];
  assert.equal(few.durationSeconds,900);assert.deepEqual(few.warnings,['供应商测试提示']);
});
test('request exact mode, alternatives, field mask and transit preference',()=>{
  for(const [mode,expected] of Object.entries({walking:'WALK',cycling:'BICYCLE',driving:'DRIVE',transit:'TRANSIT'})){
    const r=googleRouteRequest(japan,destination,{mode,strategy:'fewTransfers'});
    assert.equal(r.travelMode,expected);assert.equal(r.computeAlternativeRoutes,true);assert.equal(r.polylineEncoding,'GEO_JSON_LINESTRING');
    assert.equal('key' in r,false);assert.equal('routingPreference' in r,false);
    assert.equal(r.transitPreferences?.routingPreference,mode==='transit'?'FEWER_TRANSFERS':undefined);
  }
  assert.equal(googleRouteRequest(japan,destination,{mode:'transit',strategy:'fewWalking'}).transitPreferences.routingPreference,'LESS_WALKING');
  assert.ok(GOOGLE_ROUTE_MASK.includes('routes.legs.steps.transitDetails'));assert.ok(!GOOGLE_ROUTE_MASK.includes('*'));
});
test('local departure uses origin timezone and enforces provider date horizon',()=>{
  const r=googleRouteRequest(japan,destination,{mode:'transit',departure:'2026-10-12T09:30',now:Date.parse('2026-10-11T00:00Z')});
  assert.equal(r.departureTime,'2026-10-12T00:30:00.000Z');
  assert.throws(()=>googleRouteRequest(japan,destination,{mode:'transit',departure:'2027-10-12T09:30',now:Date.parse('2026-10-11T00:00Z')}),/100 天/);
  assert.equal(placeTimeZone({extract_region:'japan'}),'Asia/Tokyo');assert.equal(placeTimeZone({country:'US'}),'');
});
test('reject invalid and ambiguous daylight-saving wall times',()=>{
  assert.equal(departureInstant('2026-07-10T09:00','Europe/Paris'),'2026-07-10T07:00:00.000Z');
  assert.throws(()=>departureInstant('2026-03-29T02:30','Europe/Paris'),/不存在/);
  assert.throws(()=>departureInstant('2026-10-25T02:30','Europe/Paris'),/重复/);
  assert.throws(()=>departureInstant('2026-02-30T09:00','Asia/Tokyo'),/无效/);
  assert.throws(()=>departureInstant('2026-10-12T09:00','Bad/Zone'),/时区无效/);
  assert.throws(()=>departureInstant('2026-10-12T09:00',''),/选择出发地时区/);
});
test('Google place matching requests only five nearby candidates and preserves attributions',()=>{
  const request=googlePlaceRequest(japan);assert.equal(request.pageSize,5);assert.equal(request.locationBias.circle.radius,3000);
  assert.deepEqual(request.locationBias.circle.center,{latitude:35,longitude:135.76});
  const result=googlePlaceCandidates({places:[{id:'test',displayName:{text:'样本'},location:{latitude:35,longitude:135.76},attributions:[{provider:'示例来源',providerUri:'https://example.com/'}],googleMapsUri:'javascript:bad'}]})[0];
  assert.deepEqual(result.point,[35,135.76]);assert.equal(result.mapsUrl,null);assert.equal(result.attributions[0].name,'示例来源');
});
