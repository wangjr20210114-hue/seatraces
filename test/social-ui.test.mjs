import test from 'node:test';
import assert from 'node:assert/strict';
import {socialCard,routeCover,libraryCard} from '../public/social-ui.js';
import {uniqueCities} from '../public/city-selection.js';
import {stylePanel} from '../public/admin-style.js';
test('untrusted titles, topics and evidence stay text in all social views',()=>{
 const attack='<img src=x onerror=alert(1)>',markup=socialCard({id:'fixture',title:attack,nickname:attack,cities:[attack],likes:0});
 assert.ok(!markup.includes('<img src=x'));assert.match(markup,/&lt;img/);
 const panel=stylePanel({dimensions:[{key:'a',label:attack}],inferred:[{dimension:'a',window:'long',value:.2,strength:.2,confidence:.3,samples:1}],evidence:[{dimension:'a',source:attack,origin:attack,value:1,weight:1}]});
 assert.ok(!panel.includes('<img src=x'));assert.match(panel,/&lt;img/);
 assert.ok(!routeCover({cities:[attack],days:[{stops:[{lat:NaN,lng:Infinity}]}]},attack).includes('NaN'));
});
test('route adoption collapses same-country OSM/GeoNames city names but preserves genuine ambiguity',()=>{
 const list=[{id:'shanghai',name:'上海',country:'CN'},{id:'gn-1796236',name:'上海市',country:'CN'},{id:'different',name:'上海',country:'OTHER'}];
 assert.equal(uniqueCities(list.slice(0,2)).length,1);assert.equal(uniqueCities(list).length,2);
});
test('personal library cards retain author, cover, separate dates and escape all text',()=>{
 const p={id:'post-id',title:'<script>bad</script>',nickname:'作者',day_count:2,kind:'citywalk',revision:1,created_at:'2026-10-01T00:00:00Z',saved_at:'2026-10-18T00:00:00Z',record_days:3};
 const html=libraryCard(p,'browsing');assert.match(html,/最近浏览/);assert.match(html,/发布于/);assert.match(html,/作者/);assert.match(html,/3 天/);assert.match(html,/2 天路线/);assert.match(html,/route-covers/);assert.ok(!html.includes('<script>'));
 assert.match(libraryCard({...p,saved_at:'garbage'},'favorites'),/时间未记录/);assert.ok(!libraryCard(p,'favorites').includes('最近浏览'));
});
