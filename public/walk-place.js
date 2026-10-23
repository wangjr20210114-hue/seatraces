/* 整理 CityWalk 地点名称、分类及地图范围标识。 */

import {scenePoint} from './map-scene.js';

const categories = {food:'餐饮',shopping:'购物',heritage:'人文',nature:'自然',leisure:'休闲',attraction:'游览',stay:'住宿',transport:'交通'};
const kinds = {museum:'博物馆',gallery:'美术馆',cafe:'咖啡馆',restaurant:'餐厅',mall:'商场',park:'公园',monument:'纪念建筑',viewpoint:'观景点',temple:'寺庙',historic:'历史建筑'};
const text = (v, max=240) => typeof v==='string' ? v.replace(/\s+/g,' ').trim().slice(0,max) : '';

export function walkPlace(p, selected=false) {
  const point = scenePoint({...p, crs:p.crs || p.coord_system});
  if (!point) return null;
  const category = kinds[p.subcategory] || categories[p.category] || '游览';
  const description = text(p.description || p.summary || p.tags?.['description:zh'] || p.tags?.description);
  return {...point, name:text(p.name,100), selected, saved:selected, walkInfo:true,
    summary:description ? description.slice(0,22) : category,
    detail:{category,description,address:text(p.address || p.formatted_address || p.tags?.['addr:full']),
      district:text(p.district,80),opening:text(p.opening_hours || p.openingHours,160)},
    kind:p.category==='food'?'dining':undefined};
}
export function walkViewportKey(id, points) {
  return id+':'+points.map(p=>p.id+'@'+p.position.join(',')).join('|');
}
