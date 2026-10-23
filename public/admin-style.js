/* 展示兴趣画像、推荐配置和推荐预览。 */

import {esc} from './social-ui.js';
const sources={trip_answers:'本次问卷',chosen_citywalk:'手选 CityWalk',place_wish:'想去地点',manual_edit:'手动调整',not_interested:'不感兴趣',save_or_adopt:'收藏或参考路线',reaction:'点赞或推荐',effective_view:'有效浏览'};
export function recommendationPanel(result){
 const r=result.recommendation;if(!r)return '';
 const labels=new Map((result.dimensions||[]).map(d=>[d.key,d.label]));
 const rows=Object.entries({旅行:r.travel||{},内容:r.content||{}}).flatMap(([space,dims])=>Object.entries(dims).map(([key,v])=>`<tr><td>${space}</td><td>${esc(labels.get(key)||key)}</td><td>${Math.round((v.long?.value||0)*100)}%</td><td>${Math.round((v.long?.confidence||0)*100)}%</td><td>${v.long?.samples||0}</td></tr>`)).join('');
 return `<article class="admin-card"><h3>推荐画像 · ${esc(r.algorithm)}</h3><p>旅行偏好、内容兴趣、作者关系分别记录；关注作者 ${Object.keys(r.authors||{}).length} 位。模拟数据不能证明真实推荐效果。</p><div class="table-wrap"><table><thead><tr><th>画像</th><th>维度</th><th>长期倾向</th><th>置信度</th><th>证据数</th></tr></thead><tbody>${rows||'<tr><td colspan="5">尚无足够行为证据</td></tr>'}</tbody></table></div><button data-recommendation-preview>查看推荐过程</button><div data-recommendation-result></div></article>`;
}
export function bindRecommendationPreview(panel,{api,id,isCurrent}){
 const b=panel.querySelector('[data-recommendation-preview]');if(!b)return;
 b.onclick=async()=>{b.disabled=true;const box=panel.querySelector('[data-recommendation-result]');box.textContent='正在计算…';
  try{const r=await api('/api/admin/recommendation/users/'+id+'/preview');if(!isCurrent())return;
   box.innerHTML=`<p>${r.synthetic?'模拟用户 · ':''}召回 ${r.trace.counts.recall} → 粗排 ${r.trace.counts.coarse} → 精排 ${r.trace.counts.fine} → 重排 ${r.trace.counts.rerank}；耗时 ${r.trace.elapsedMs} ms</p><p>双塔：${r.trace.models.tower?'已启用':'规则回退'}；精排：${r.trace.models.ranker?'已训练模型':'规则基线'}</p><ol>${r.items.map(p=>`<li>${esc(p.title)}</li>`).join('')}</ol>`;
  }catch(e){if(isCurrent())box.textContent=e.message;}finally{b.disabled=false;}
 };
}
export function stylePanel(result){
 const dimensions=result.dimensions||[],byKey=new Map(dimensions.map(d=>[d.key,d])),rows=result.inferred||[];
 const seen=new Set(rows.map(r=>r.dimension)),unknown=dimensions.filter(d=>!seen.has(d.key));
 const table=(heads,body)=>`<div class="table-wrap"><table><thead><tr>${heads.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${body||`<tr><td colspan="${heads.length}">暂无足够证据</td></tr>`}</tbody></table></div>`;
 return `<article class="admin-card"><h3>行为推断 · ${esc(result.algorithm||'待计算')}</h3><p>与用户确认的记忆分开保存。短期 14 天、长期 365 天；负分表示回避，未知不补零。推断仅小幅影响推荐，不修改本次明确要求。</p></article>
 ${table(['维度','时间范围','倾向','强度','置信度','独立证据数'],rows.map(r=>`<tr><td>${esc(byKey.get(r.dimension)?.label||r.dimension)}</td><td>${r.window==='short'?'短期':'长期'}</td><td>${(r.value*100).toFixed(0)}%</td><td>${(r.strength*100).toFixed(0)}%</td><td>${(r.confidence*100).toFixed(0)}%</td><td>${r.samples}</td></tr>`).join(''))}
 <details class="admin-card"><summary>尚不明确的 ${unknown.length} 个维度</summary><p>${unknown.map(d=>esc(d.label)).join('、')}</p></details>
 <details class="admin-card"><summary>最近的推断证据</summary>${table(['维度','来源','作用','权重','记录'],(result.evidence||[]).map(e=>`<tr><td>${esc(byKey.get(e.dimension)?.label||e.dimension)}</td><td>${esc(sources[e.source]||e.source)}</td><td>${e.value<0?'回避':'倾向'}</td><td>${Number(e.weight).toFixed(2)}</td><td><code>${esc(e.origin)}</code></td></tr>`).join(''))}</details>`;
}
