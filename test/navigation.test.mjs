/* 验证路线导航与步行进度。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { walkingGeometry, walkingProgress, navigationUrl } from '../public/navigation.js';
import { toGcj } from '../public/coordinates.js';

const turn = { mode: 'walk', steps: [
  { instruction: '向北直行', polyline: [[31,121],[31.001,121]] },
  { instruction: '右转向东', polyline: [[31.001,121],[31.001,121.001]] }
] };
const fix = (latitude,longitude,accuracy=5,timestamp=10000) => ({latitude,longitude,accuracy,timestamp});
test('walking progress follows the road and advances nested instructions', () => {
  const g=walkingGeometry(turn), first=walkingProgress(g,fix(31.0005,121));
  assert.equal(first.status,'on_route'); assert.equal(first.stepIndex,0);
  assert.ok(first.remainingMeters>140&&first.remainingMeters<160);
  const next=walkingProgress(g,fix(31.001,121.0005,5,60000),first);
  assert.equal(next.stepIndex,1);assert.equal(next.instruction,'右转向东');assert.ok(next.remainingMeters<50);
});
test('poor GPS and off-route positions cannot report arrival', () => {
  const g=walkingGeometry(turn);
  assert.equal(walkingProgress(g,fix(31.001,121.001,150)).status,'low_accuracy');
  assert.equal(walkingProgress(g,fix(31.002,121.002)).status,'off_route');
  assert.equal(walkingProgress(g,fix(31.001,121.001)).nearEnd,true);
});
test('a loop endpoint near its start does not cause false arrival', () => {
  const g=walkingGeometry({mode:'walk',steps:[{instruction:'环路',polyline:[[31,121],[31.001,121],[31.001,121.001],[31,121.001],[31,121]]}]});
  const p=walkingProgress(g,fix(31,121));assert.equal(p.nearEnd,false);assert.equal(p.along,0);
  const last=walkingProgress(g,fix(31,121),{along:g.total-10,timestamp:9000});assert.equal(last.nearEnd,true);
});
test('GPS teleportation does not skip walking instructions', () => {
  const g=walkingGeometry(turn), previous=walkingProgress(g,fix(31,121));
  assert.equal(walkingProgress(g,fix(31.001,121.001,5,11000),previous).status,'uncertain_jump');
});
test('missing or disconnected geometry disables progress', () => {
  assert.equal(walkingGeometry({mode:'walk',steps:[turn.steps[0],{instruction:'缺失',polyline:[]}]}),null);
  assert.equal(walkingGeometry({mode:'walk',steps:[turn.steps[0],{polyline:[[32,122],[32.001,122]]}]}),null);
  assert.equal(walkingGeometry({mode:'metro',polyline:turn.steps[0].polyline}),null);
});
const endpoints={from:{lat:31,lng:121},to:{lat:31.001,lng:121.001},convertToGcj:toGcj};
test('Amap walking and cycling handoffs preserve mode and use GCJ02', () => {
  for(const [mode,expected] of [['walking','walk'],['cycling','ride'],['driving','car'],['transit','bus']]) {
    const u=new URL(navigationUrl({...endpoints,mainland:true,mode}));
    assert.equal(u.searchParams.get('mode'),expected);
    assert.equal(u.searchParams.get('from'),toGcj(endpoints.from)+',起点');
    assert.equal(u.searchParams.has('coordinate'),false);
  }
});
test('a walking transfer uses its own endpoints and mode', () => {
  const leg={mode:'walk',start:[31.0002,121],end:[31.0004,121]};
  const u=new URL(navigationUrl({...endpoints,mode:'transit',leg}));
  assert.equal(u.searchParams.get('travelmode'),'walking');
  assert.equal(u.searchParams.get('origin'),'31.0002,121');
  assert.equal(navigationUrl({...endpoints,mode:'transit',leg:{mode:'train',start:null,end:null}}),null);
});
test('overseas cycling handoff keeps WGS84 and cycling mode', () => {
  const u=new URL(navigationUrl({...endpoints,mode:'cycling'}));
  assert.equal(u.searchParams.get('travelmode'),'bicycling');
  assert.equal(u.searchParams.get('origin'),'31,121');
});
