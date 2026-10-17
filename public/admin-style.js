import {esc} from './social-ui.js';
const sources={trip_answers:'本次问卷',chosen_citywalk:'手选 CityWalk',place_wish:'想去地点',manual_edit:'手动调整',not_interested:'不感兴趣',save_or_adopt:'收藏或参考路线',reaction:'点赞或推荐',effective_view:'有效浏览'};
export function stylePanel(result){
 const dimensions=result.dimensions||[],byKey=new Map(dimensions.map(d=>[d.key,d])),rows=result.inferred||[];
 const seen=new Set(rows.map(r=>r.dimension)),unknown=dimensions.filter(d=>!seen.has(d.key));
 const table=(heads,body)=>`<div class="table-wrap"><table><thead><tr>${heads.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${body||`<tr><td colspan="${heads.length}">暂无足够证据</td></tr>`}</tbody></table></div>`;
 return `<article class="admin-card"><h3>行为推断 · ${esc(result.algorithm||'待计算')}</h3><p>与用户确认的记忆分开保存。短期 14 天、长期 365 天；负分表示回避，未知不补零。推断仅小幅影响推荐，不修改本次明确要求。</p></article>
 ${table(['维度','时间范围','倾向','强度','置信度','独立证据数'],rows.map(r=>`<tr><td>${esc(byKey.get(r.dimension)?.label||r.dimension)}</td><td>${r.window==='short'?'短期':'长期'}</td><td>${(r.value*100).toFixed(0)}%</td><td>${(r.strength*100).toFixed(0)}%</td><td>${(r.confidence*100).toFixed(0)}%</td><td>${r.samples}</td></tr>`).join(''))}
 <details class="admin-card"><summary>尚不明确的 ${unknown.length} 个维度</summary><p>${unknown.map(d=>esc(d.label)).join('、')}</p></details>
 <details class="admin-card"><summary>最近的推断证据</summary>${table(['维度','来源','作用','权重','记录'],(result.evidence||[]).map(e=>`<tr><td>${esc(byKey.get(e.dimension)?.label||e.dimension)}</td><td>${esc(sources[e.source]||e.source)}</td><td>${e.value<0?'回避':'倾向'}</td><td>${Number(e.weight).toFixed(2)}</td><td><code>${esc(e.origin)}</code></td></tr>`).join(''))}</details>`;
}
