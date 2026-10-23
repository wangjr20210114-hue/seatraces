/* 解析页面地址，处理导航、返回和页面恢复。 */

const pages = new Set([
  "home",
  "discover",
  "profile",
  "account",
  "history",
  "favorites",
  "browsing",
  "report",
  "citywalk",
  "services",
  "agent",
  "settings",
  "messages",
  "walks", "style", "security", "help",
  "post", "compose", "social-messages",
]);

function parseRoute(hash) {
  const [pathname, search = ""] = hash.replace(/^#?\/?/, "").split("?");
  const parts = pathname.split("/");
  const page = pages.has(parts[0]) ? parts[0] : "home";
  let id = "";
  if (["history", "citywalk", "services", "messages", "favorites", "browsing", "post", "compose"].includes(page) && parts[1]) {
    try {
      id = decodeURIComponent(parts[1]);
    } catch {
    }
  }
  const params =
    page === "services"
      ? Object.fromEntries(
          [...new URLSearchParams(search)].filter(([k]) =>
            ["day", "slot", "place", "radius", "recommendation"].includes(k),
          ),
        )
      : page === 'compose' && new URLSearchParams(search).get('write') === '1' ? {write:'1'} : {};
  const query = new URLSearchParams(params).toString();
  return {
    page,
    id,
    params,
    path:
      "/" +
      page +
      (id ? "/" + encodeURIComponent(id) : "") +
      (query ? "?" + query : ""),
  };
}

export function createPageNavigation({ onChange, onRepeat }) {
  let current, currentDepth = 0,
    started = false;
  function render(animate = false) {
    const route = parseRoute(location.hash);
    if (route.path === current?.path) return;
    const depth = history.state?.seatracesPage?.depth || 0;
    const main = ['home','discover','profile'];
    const direction = depth < currentDepth ? 'back' : main.includes(current?.page) && main.includes(route.page) ? 'tab' : 'forward';
    current = route;
    currentDepth = depth;
    onChange(route, { animate, direction });
  }
  function go(path, { replace = false } = {}) {
    const route = parseRoute(path);
    if (route.path === current?.path) {
      onRepeat(route);
      return;
    }
    const depth = history.state?.seatracesPage?.depth || 0;
    history[replace ? "replaceState" : "pushState"](
      { seatracesPage: { depth: replace ? depth : depth + 1 } },
      "",
      "#" + route.path,
    );
    render(true);
  }
  return {
    go,
    start() {
      if (started) return;
      started = true;
      const route = parseRoute(location.hash);
      history.replaceState(
        { seatracesPage: { depth: history.state?.seatracesPage?.depth || 0 } },
        "",
        "#" + route.path,
      );
      window.addEventListener("popstate", () => render(true));
      window.addEventListener("hashchange", () => render(true));
      document.addEventListener('click', event => {
        if(event.defaultPrevented || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)return;
        const a=event.target.closest?.('a[href^="#/"]');
        if(!a || a.hasAttribute('download') || (a.target && a.target!=='_self'))return;
        const href=a.getAttribute('href');
        if(!pages.has(href.slice(2).split(/[/?]/)[0]))return;
        event.preventDefault();go(href);
      });
      render();
    },
    back() {
      if (history.state?.seatracesPage?.depth > 0) history.back();
      else
        go(
          ['post','compose'].includes(current?.page)?'/discover':current?.page==='messages' ? current.id?'/messages':'/settings' : ["citywalk", "services"].includes(current?.page)
            ? "/home"
            : current?.id
              ? ['favorites','browsing'].includes(current.page)?'/'+current.page:'/history'
              : "/profile",
          { replace: true },
        );
    },
  };
}
