import { scenePoint } from './map-scene.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function routePreview(plan = {}) {
  const stops = (plan.days || []).flatMap(day => day.stops || []);
  return stops.map((stop, index) => {
    if (stop.lat == null || stop.lng == null || stop.lat === '' || stop.lng === '' ||
        !Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lng)) ||
        Math.abs(Number(stop.lat)) > 90 || Math.abs(Number(stop.lng)) > 180) return null;
    return { ...scenePoint(stop), number: index + 1 };
  }).filter(Boolean);
}

export function routeThumbnail(plan) {
  const points = routePreview(plan);
  if (!points.length) return '<div class="discovery-map-empty">这条路线暂未提供景点坐标 · 可展开查看景点</div>';
  const coords = points.map(p => [p.position[0], -Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, p.position[1])) * Math.PI / 360)) * 180 / Math.PI]);
  const xs = coords.map(p => p[0]), ys = coords.map(p => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const width = Math.max(...xs) - minX, height = Math.max(...ys) - minY;
  const scale = Math.min(520 / (width || 1e-6), 180 / (height || 1e-6));
  const projected = coords.map(([x,y]) => [300 + (x-minX-width/2)*scale, 120 + (y-minY-height/2)*scale]);
  return `<figure class="discovery-map"><div class="discovery-map-canvas"><svg viewBox="0 0 600 240" role="img" aria-label="路线景点位置示意图"><rect width="600" height="240" fill="#eaf1e7"/><path d="M0 60H600M0 120H600M0 180H600M100 0V240M200 0V240M300 0V240M400 0V240M500 0V240" stroke="#d7e4d5" fill="none"/><polyline points="${projected.map(p=>p.join(',')).join(' ')}" fill="none" stroke="#238577" stroke-width="4" stroke-dasharray="7 5"/>${projected.map(([x,y],i)=>`<g><title>${esc(points[i].name)}</title><circle cx="${x}" cy="${y}" r="12" fill="#225d4d" stroke="white" stroke-width="2"/><text x="${x}" y="${y+4}" text-anchor="middle" fill="white" font-size="11">${points[i].number}</text></g>`).join('')}</svg><iframe data-route-map src="/amap-view.html?mode=thumbnail" loading="lazy" title="路线地图缩略图" tabindex="-1"></iframe></div><figcaption>路线概览 · ${points.length} 个定位景点 · 连线为游览顺序示意</figcaption></figure>`;
}

export function discoveryCard(post) {
  const plan = post.snapshot || {}, days = Array.isArray(plan.days) ? plan.days : [];
  const stops = days.flatMap(day => day.stops || []);
  return `<article class="discovery-route" data-post-id="${esc(post.id)}"><p class="muted">${esc(post.avatar || '🌊')} ${esc(post.nickname || '旅行者')}${post.isOwn ? ' · 我的发布' : ''} · ${plan.kind === 'citywalk' ? 'CityWalk' : '旅行路线'}</p>
    <h2>${esc(post.title)}</h2><p>${esc((plan.cities || []).join(' · '))} · ${days.length} 天 · ${stops.length} 个景点${Number.isFinite(plan.distance_m) ? ` · 约 ${(plan.distance_m / 1000).toFixed(1)} 公里（直线估算）` : ''}</p>
    ${routeThumbnail(plan)}
    <p class="discovery-body">${esc(post.body)}</p><p class="muted">${esc(post.reason)}</p>
    <details><summary>查看路线与景点</summary>${days.map((day, i) => `<section><h3>第 ${i + 1} 天 · ${esc(day.city)}</h3><ol>${(day.stops || []).map(stop => `<li>${esc(stop.name)}</li>`).join('')}</ol></section>`).join('')}</details>
    ${post.isOwn ? '<button type="button" class="loadmore" data-edit>编辑帖子</button><div data-editor></div>' : ''}
  </article>`;
}

let preferredScope = 'all';
const publishing = new Set();
export async function publishRoute({ button, kind, id, api, navigate, toast }) {
  const key = kind + ':' + id;
  if (publishing.has(key)) return;
  const originalLabel = button.textContent;
  publishing.add(key); button.disabled = true; button.textContent = '正在发布…';
  try {
    await api('/api/discovery/publish', {kind,id});
    preferredScope = 'mine';
    toast('发布成功，可在发现 · 我的发布中查看');
    if (button.isConnected) navigate('/discover');
  } catch (error) {
    toast(error.message || '发布失败，请重试');
  } finally {
    publishing.delete(key); button.disabled = false; button.textContent = originalLabel;
  }
}

export function mountDiscovery({ content, api }) {
  let disposed = false, revision = 0, scope = preferredScope, posts = [], shown = 0, hasMore = false;
  const records = new Map();
  content.innerHTML = '<div class="discovery-actions"><button type="button" data-scope="all" class="loadmore">发现路线</button><button type="button" data-scope="mine" class="loadmore">我的发布</button></div><p data-status role="status"></p><div data-feed></div><button type="button" data-more class="loadmore" hidden>更多路线 ↓</button>';
  const status = content.querySelector('[data-status]'), feed = content.querySelector('[data-feed]');
  const more = content.querySelector('[data-more]');
  const tabs = [...content.querySelectorAll('[data-scope]')];
  function renderItems(items) {
    items.forEach(post => records.set(String(post.id), post));
    feed.insertAdjacentHTML('beforeend', items.map(discoveryCard).join(''));
  }
  const onMapReady = event => {
    if (event.origin !== location.origin || event.data?.type !== 'seatraces-map-ready') return;
    const frame = [...feed.querySelectorAll('[data-route-map]')].find(f => f.contentWindow === event.source);
    if (!frame) return;
    const post = records.get(frame.closest('[data-post-id]').dataset.postId);
    const stops = routePreview(post?.snapshot);
    event.source.postMessage({type:'seatraces-route',view:'day',lockView:true,segments:[],stops,
      connections: stops.slice(1).map((p,i)=>({path:[stops[i].position,p.position]})),
      fitKey:post.id,contextKey:post.id,viewPadding:[25,25,25,25]}, location.origin);
    frame.classList.add('ready');
  };
  window.addEventListener('message', onMapReady);
  feed.onclick = event => {
    const button = event.target.closest('[data-edit]');
    if (!button) return;
    const card = button.closest('[data-post-id]'), post = records.get(card.dataset.postId);
    if (!post?.isOwn) return;
    const editor = card.querySelector('[data-editor]');
    if (editor.childElementCount) return;
    button.hidden = true;
    editor.innerHTML = `<form class="discovery-editor"><label>帖子标题<input name="title" required maxlength="100" value="${esc(post.title)}"></label><label>旅行分享<textarea name="body" required maxlength="4000" rows="5">${esc(post.body)}</textarea></label><p role="status" data-edit-status></p><div class="discovery-actions"><button type="button" class="loadmore" data-cancel>取消</button><button class="loadmore" type="submit">保存修改</button></div></form>`;
    const form = editor.querySelector('form');
    form.elements.title.focus();
    editor.querySelector('[data-cancel]').onclick = () => { editor.replaceChildren(); button.hidden = false; button.focus(); };
    form.onsubmit = async event => {
      event.preventDefault();
      const title = form.elements.title.value.trim(), body = form.elements.body.value.trim();
      const message = editor.querySelector('[data-edit-status]');
      if (!title || !body) { message.textContent = '标题和正文不能为空'; return; }
      const controls = [...form.querySelectorAll('button,input,textarea')];
      controls.forEach(control => control.disabled = true);
      message.textContent = '正在保存…';
      try {
        const updated = await api(`/api/discovery/posts/${encodeURIComponent(post.id)}`, {title,body}, 'PATCH');
        if (disposed || !card.isConnected) return;
        const merged = {...post,...updated,isOwn:true};
        records.set(String(post.id),merged);
        posts = posts.map(p=>p.id === post.id ? merged : p);
        card.outerHTML = discoveryCard(merged);
        status.textContent = '帖子已更新';
      } catch (error) {
        message.textContent = error.message || '保存失败，请重试';
        controls.forEach(control => control.disabled = false);
      }
    };
  };
  async function load(append = false) {
    const current = ++revision;
    more.disabled = true;
    tabs.forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.scope === scope)));
    status.textContent = '正在寻找旅行灵感…';
    try {
      if (scope === 'mine') {
        const result = await api(`/api/discovery/mine?limit=12&offset=${append ? shown : 0}`);
        if (disposed || current !== revision) return;
        if (!append) { shown = 0; feed.replaceChildren(); }
        renderItems(result.items);
        shown += result.items.length; hasMore = result.hasMore;
      } else {
        if (!append) {
          const result = await api('/api/posts');
          if (disposed || current !== revision) return;
          posts = result; shown = 0; feed.replaceChildren();
        }
        renderItems(posts.slice(shown, shown + 12));
        shown = Math.min(shown + 12, posts.length); hasMore = shown < posts.length;
      }
      more.hidden = !hasMore;
      status.textContent = shown ? '' : scope === 'mine' ? '还没有发布。在路线标题右侧点击“分享”。' : '还没有分享的路线。';
    } catch (error) {
      if (!disposed && current === revision) status.textContent = `${error.message || '路线加载失败'}，请重试。`;
    } finally {
      if (!disposed && current === revision) { more.disabled = false; }
    }
  }
  tabs.forEach(tab => { tab.onclick = () => {
    if (scope === tab.dataset.scope) return;
    preferredScope = scope = tab.dataset.scope;
    feed.replaceChildren(); more.hidden = true;
    void load();
  }; });
  more.onclick = () => load(true);
  const onVisible = () => { if (!document.hidden && !feed.querySelector("form")) void load(); };
  document.addEventListener('visibilitychange', onVisible);
  void load();
  return () => { disposed = true; window.removeEventListener("message", onMapReady); document.removeEventListener('visibilitychange', onVisible); };
}
