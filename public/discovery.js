const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function discoveryCard(post) {
  const plan = post.snapshot || {}, days = Array.isArray(plan.days) ? plan.days : [];
  const stops = days.flatMap(day => day.stops || []);
  return `<article class="discovery-route"><p class="muted">${esc(post.avatar || '🌊')} ${esc(post.nickname || '旅行者')}${post.isOwn ? ' · 我的发布' : ''} · ${plan.kind === 'citywalk' ? 'CityWalk' : '旅行路线'}</p>
    <h2>${esc(post.title)}</h2><p>${esc((plan.cities || []).join(' · '))} · ${days.length} 天 · ${stops.length} 个景点${Number.isFinite(plan.distance_m) ? ` · 约 ${(plan.distance_m / 1000).toFixed(1)} 公里（直线估算）` : ''}</p>
    <p>${esc(post.body)}</p><p class="muted">${esc(post.reason)}</p>
    <details><summary>查看路线与景点</summary>${days.map((day, i) => `<section><h3>第 ${i + 1} 天 · ${esc(day.city)}</h3><ol>${(day.stops || []).map(stop => `<li>${esc(stop.name)}</li>`).join('')}</ol></section>`).join('')}</details>
  </article>`;
}

let preferredScope = 'all';
const publishing = new Set();
export async function publishRoute({ button, kind, id, api, navigate, toast }) {
  const key = kind + ':' + id;
  if (publishing.has(key)) return;
  publishing.add(key); button.disabled = true; button.textContent = '正在发布…';
  try {
    await api('/api/discovery/publish', {kind,id});
    preferredScope = 'mine';
    toast('发布成功，可在发现 · 我的发布中查看');
    if (button.isConnected) navigate('/discover');
  } catch (error) {
    toast(error.message || '发布失败，请重试');
  } finally {
    publishing.delete(key); button.disabled = false; button.textContent = '发布到发现 ↗';
  }
}

export function mountDiscovery({ content, api }) {
  let disposed = false, revision = 0, scope = preferredScope, posts = [], shown = 0, hasMore = false;
  content.innerHTML = '<div class="discovery-actions"><button type="button" data-scope="all" class="loadmore">发现路线</button><button type="button" data-scope="mine" class="loadmore">我的发布</button><button type="button" data-refresh class="loadmore">刷新路线 ↻</button></div><p data-status role="status"></p><div data-feed></div><button type="button" data-more class="loadmore" hidden>更多路线 ↓</button>';
  const status = content.querySelector('[data-status]'), feed = content.querySelector('[data-feed]');
  const refresh = content.querySelector('[data-refresh]'), more = content.querySelector('[data-more]');
  const tabs = [...content.querySelectorAll('[data-scope]')];
  async function load(append = false) {
    const current = ++revision;
    refresh.disabled = true; more.disabled = true;
    tabs.forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.scope === scope)));
    status.textContent = '正在寻找旅行灵感…';
    try {
      if (scope === 'mine') {
        const result = await api(`/api/discovery/mine?limit=12&offset=${append ? shown : 0}`);
        if (disposed || current !== revision) return;
        if (!append) { shown = 0; feed.replaceChildren(); }
        feed.insertAdjacentHTML('beforeend', result.items.map(discoveryCard).join(''));
        shown += result.items.length; hasMore = result.hasMore;
      } else {
        if (!append) {
          const result = await api('/api/posts');
          if (disposed || current !== revision) return;
          posts = result; shown = 0; feed.replaceChildren();
        }
        feed.insertAdjacentHTML('beforeend', posts.slice(shown, shown + 12).map(discoveryCard).join(''));
        shown = Math.min(shown + 12, posts.length); hasMore = shown < posts.length;
      }
      more.hidden = !hasMore;
      status.textContent = shown ? '' : scope === 'mine' ? '你还没有发布帖子。在最终路线下点击“发布到发现”，就能在这里看见。' : '还没有分享的路线，发布一条路线，开启新的旅行灵感。';
    } catch (error) {
      if (!disposed && current === revision) status.textContent = `${error.message || '路线加载失败'}，请重试。`;
    } finally {
      if (!disposed && current === revision) { refresh.disabled = false; more.disabled = false; }
    }
  }
  tabs.forEach(tab => { tab.onclick = () => {
    if (scope === tab.dataset.scope) return;
    preferredScope = scope = tab.dataset.scope;
    feed.replaceChildren(); more.hidden = true;
    void load();
  }; });
  refresh.onclick = () => load(); more.onclick = () => load(true);
  const onVisible = () => { if (!document.hidden) void load(); };
  document.addEventListener('visibilitychange', onVisible);
  void load();
  return () => { disposed = true; document.removeEventListener('visibilitychange', onVisible); };
}
