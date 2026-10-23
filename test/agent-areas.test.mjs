/* 验证AI 旅行片区选择。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTravelAreas } from '../server/agent/area-selection.mjs';
const points = (prefix, traits, extra = {}) => Array.from({length:6}, (_,i) => ({id:prefix+i,name:prefix+i,category:'attraction',traits,...extra}));
test('automatic areas use this trip interests, preserve wishes and exclude forbidden/visited candidates', () => {
  const groups=[
    {id:'park',name:'公园',members:points('p',{leisure:'park'})},
    {id:'museum',name:'展馆',members:points('m',{tourism:'museum'})},
    {id:'wish',name:'想去',members:points('w',{}, {wanted:true})},
    {id:'visited',name:'去过',members:points('v',{tourism:'museum'}, {visited:true})},
  ];
  const prefs={interests:['艺术'],pace:'relaxed',revisit:'new',avoidPlaceNames:groups[2].members.map(p=>p.name)};
  assert.deepEqual(selectTravelAreas(groups,prefs).map(g=>g.id),['museum']);
  assert.deepEqual(selectTravelAreas(groups,{...prefs,interests:['自然']}).map(g=>g.id),['park']);
  assert.deepEqual(selectTravelAreas(groups,{...prefs,avoidPlaceNames:[]}).map(g=>g.id),['wish']);
  assert.ok(selectTravelAreas(groups,prefs,5).length>1);
  assert.deepEqual(selectTravelAreas([groups[3]],prefs),[]);
  assert.equal(selectTravelAreas([groups[3]],{...prefs,revisit:'either'}).length,1);
});
