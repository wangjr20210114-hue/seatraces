const pages = new Set(['home', 'discover', 'profile', 'account', 'history', 'favorites', 'browsing', 'report', 'citywalk','services']);

function parseRoute(hash) {
  const [pathname,search=''] = hash.replace(/^#?\/?/, '').split('?');
  const parts = pathname.split('/');
  const page = pages.has(parts[0]) ? parts[0] : 'home';
  let id = '';
  if (['history', 'citywalk','services'].includes(page) && parts[1]) {
    try { id = decodeURIComponent(parts[1]); } catch { /* Invalid URLs open the list. */ }
  }
  const params = page==='services'?Object.fromEntries([...new URLSearchParams(search)].filter(([k])=>['day','slot','place','radius'].includes(k))):{};
  const query = new URLSearchParams(params).toString();
  return { page, id, params, path: '/' + page + (id ? '/' + encodeURIComponent(id) : '')+(query?'?'+query:'') };
}

// Same-document history keeps the map and in-progress questionnaire alive.
export function createPageNavigation({ onChange, onRepeat }) {
  let current, started = false;
  function render(animate = false) {
    const route = parseRoute(location.hash);
    if (route.path === current?.path) return;
    current = route;
    onChange(route, { animate });
  }
  function go(path, { replace = false } = {}) {
    const route = parseRoute(path);
    if (route.path === current?.path) { onRepeat(route); return; }
    const depth = history.state?.seatracesPage?.depth || 0;
    history[replace ? 'replaceState' : 'pushState'](
      { seatracesPage: { depth: replace ? depth : depth + 1 } }, '', '#' + route.path,
    );
    render(true);
  }
  return {
    go,
    start() {
      if (started) return;
      started = true;
      const route = parseRoute(location.hash);
      history.replaceState({ seatracesPage: { depth: history.state?.seatracesPage?.depth || 0 } }, '', '#' + route.path);
      window.addEventListener('popstate', () => render());
      window.addEventListener('hashchange', () => render());
      render();
    },
    back() {
      if (history.state?.seatracesPage?.depth > 0) history.back();
      else go(['citywalk','services'].includes(current?.page) ? '/home' : current?.id ? '/history' : '/profile', { replace: true });
    },
  };
}
