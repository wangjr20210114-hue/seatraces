const pages = new Set(['home', 'discover', 'profile', 'account', 'history', 'favorites', 'browsing', 'report', 'citywalk']);

function parseRoute(hash) {
  const parts = hash.replace(/^#?\/?/, '').split('/');
  const page = pages.has(parts[0]) ? parts[0] : 'home';
  let id = '';
  if (['history', 'citywalk'].includes(page) && parts[1]) {
    try { id = decodeURIComponent(parts[1]); } catch { /* Invalid URLs open the list. */ }
  }
  return { page, id, path: '/' + page + (id ? '/' + encodeURIComponent(id) : '') };
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
      else go(current?.page === 'citywalk' ? '/home' : current?.id ? '/history' : '/profile', { replace: true });
    },
  };
}
