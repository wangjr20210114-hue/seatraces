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
]);

function parseRoute(hash) {
  const [pathname, search = ""] = hash.replace(/^#?\/?/, "").split("?");
  const parts = pathname.split("/");
  const page = pages.has(parts[0]) ? parts[0] : "home";
  let id = "";
  if (["history", "citywalk", "services", "messages", "favorites", "browsing"].includes(page) && parts[1]) {
    try {
      id = decodeURIComponent(parts[1]);
    } catch {
      /* Invalid URLs open the list. */
    }
  }
  const params =
    page === "services"
      ? Object.fromEntries(
          [...new URLSearchParams(search)].filter(([k]) =>
            ["day", "slot", "place", "radius", "recommendation"].includes(k),
          ),
        )
      : {};
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

// Same-document history keeps the map and in-progress questionnaire alive.
export function createPageNavigation({ onChange, onRepeat }) {
  let current,
    started = false;
  function render(animate = false) {
    const route = parseRoute(location.hash);
    if (route.path === current?.path) return;
    current = route;
    onChange(route, { animate });
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
      window.addEventListener("popstate", () => render());
      window.addEventListener("hashchange", () => render());
      // In-app links must use the same history stack as buttons, otherwise a
      // native hash entry has no depth and Back skips its parent page.
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
          current?.page==='messages' ? current.id?'/messages':'/settings' : ["citywalk", "services"].includes(current?.page)
            ? "/home"
            : current?.id
              ? ['favorites','browsing'].includes(current.page)?'/'+current.page:'/history'
              : "/profile",
          { replace: true },
        );
    },
  };
}
