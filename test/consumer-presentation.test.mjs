import test from 'node:test';
import assert from 'node:assert/strict';
import {walkPlace,walkViewportKey} from '../public/walk-place.js';
import {createPageMotion} from '../public/page-motion.js';
import {socialCard} from '../public/social-ui.js';
import {composeSuggestion} from '../server/social/writing.mjs';

test('walk labels are bounded factual summaries, respect CRS and update bounds when candidates arrive',()=>{
 const p={id:'cafe',name:'咖啡馆',lat:31.2,lng:121.4,category:'food',subcategory:'cafe',country:'CN',coord_system:'GCJ02'};
 const a=walkPlace(p);assert.deepEqual(a.position,[121.4,31.2]);assert.equal(a.summary,'咖啡馆');assert.equal(a.detail.description,'');assert.equal(a.detail.opening,'');
 const b=walkPlace({...p,id:'second',lng:121.405,description:'有来源的描述'.repeat(200),address:'街道 1 号',opening_hours:'09:00-18:00'},true);
 assert.equal(b.summary.length,22);assert.equal(b.detail.description.length,240);assert.equal(b.detail.address,'街道 1 号');assert.equal(b.selected,true);
 assert.notEqual(walkViewportKey('same',[a]),walkViewportKey('same',[a,b]));
 assert.notDeepEqual(walkPlace({...p,coord_system:'WGS84'}).position,a.position);
 assert.equal(walkPlace({...p,lat:NaN}),null);
});
test('rapid page changes cancel prior motion; reduced motion and repeated navigation do not animate',()=>{
 let cancelled=0,animations=0,last;
 const el={animate:(frames,options)=>{animations++;last={frames,options};return {cancel(){cancelled++;}};}};
 const move=createPageMotion({reduced:()=>false});
 for(let i=0;i<100;i++)move(el,{animate:true,direction:i%2?'back':'tab'});
 assert.equal(animations,100);assert.equal(cancelled,99);assert.match(last.frames[0].transform,/-18px/);assert.equal(last.options.fill,'none');
 move(el,{animate:false});assert.equal(cancelled,100);assert.equal(animations,100);
 createPageMotion({reduced:()=>true})(el,{animate:true});assert.equal(animations,100);
});
test('feed excerpts and map labels escape content; active actions are accessible icons',()=>{
 const html=socialCard({id:'test',title:'路线',excerpt:'<script>bad</script>',cities:['<img src=x>'],avatar:'🌊',nickname:'作者',likes:2,liked:true});
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img src=x>'));assert.match(html,/&lt;script&gt;/);assert.match(html,/aria-label="取消点赞"/);assert.match(html,/class="ui-icon"/);assert.match(html,/social-excerpt/);
});
test('travel-note writing uses supplied route facts, preserves review and avoids fabricated experiences',()=>{
 const d={snapshot:{kind:'citywalk',days:[{city:'上海',stops:[{name:'外滩'},{name:'豫园'}]}]}};
 const note=composeSuggestion(d,{tone:'lively',highlightIds:['day-0'],ending:'save'});
 assert.match(note.title,/从外滩，逛到豫园/);assert.match(note.body,/01  外滩\n02  豫园/);assert.doesNotMatch(note.body,/亲测|人少|免费|分钟|公里|绝美|已去/);assert.ok(note.requiresReview);assert.ok(note.tags.includes('CityWalk'));
 assert.notEqual(note.body,composeSuggestion(d,{tone:'concise',highlightIds:[],ending:'none'}).body);
});
