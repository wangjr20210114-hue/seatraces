import { renderAccountPage } from "./account-page.js";

const features = {
  favorites: {
    title: "我的收藏",
    icon: "☆",
    color: "yellow",
    text: "心动的路线，留给下次出发。",
  },
  browsing: {
    title: "历史浏览",
    icon: "◷",
    color: "peach",
    text: "让偶然遇见的风景，有迹可循。",
  },
  report: {
    title: "旅行报告",
    icon: "▤",
    color: "lilac",
    text: "走过的风景，会变成你的旅行故事。",
  },
};

export async function renderProfilePage({
  route,
  content,
  setTitle,
  api,
  esc,
  isCurrent,
  navigate,
  onTrip,
  onUser,
  onLogout,
}) {
  setTitle(
    route.page === "account"
      ? "我的账号"
      : route.page === "history"
        ? route.id
          ? "旅行详情"
          : "历史行程"
        : features[route.page].title,
  );
  content.innerHTML = '<p class="page-status" role="status">正在打开…</p>';
  try {
    if (route.page === "account") {
      await renderAccountPage({
        content,
        api,
        esc,
        isCurrent,
        onUser,
        onLogout,
      });
    } else if (route.page === "history" && route.id) {
      const trip = await api("/api/trips/" + encodeURIComponent(route.id));
      if (!isCurrent()) return;
      setTitle("旅行详情");
      const days = trip.plan?.days || [];
      content.innerHTML = `<div class="trip-detail-heading"><span class="eyebrow">MY JOURNEY</span><h2>${esc(trip.title)}</h2><p class="muted">${esc(trip.request?.start || "")} — ${esc(trip.request?.end || "")}</p></div>
        ${trip.plan?.schemaVersion === "journey/2" ? '<button class="primary page-map-action">在地图上查看 ↗</button>' : ""}
        ${
          days
            .map(
              (
                day,
                index,
              ) => `<article class="trip-day"><header><span class="day-number">Day ${index + 1}</span><div><h3>${esc(day.city || "")}</h3><small>${esc(day.date)}</small></div></header>
          ${(day.stops || []).length ? `<ol class="trip-stop-list">${day.stops.map((stop) => `<li><span>${esc(stop.name)}</span>${stop.arrive ? `<small>${esc(stop.arrive)}</small>` : ""}</li>`).join("")}</ol>` : '<p class="muted">自由时光</p>'}${Object.values(
            trip.plan.services || {},
          )
            .filter((s) => s.days?.includes(index))
            .map(
              (s) =>
                `<div class="service-saved-summary">${s.kind === "stay" ? "🛏 住宿" : "🍜 餐饮"} · ${esc(s.candidate.name)}</div>`,
            )
            .join(
              "",
            )}${trip.plan.schemaVersion === "journey/2" ? `<a class="inline-action" href="#/services/${encodeURIComponent(trip.id)}?day=${index}">看看附近吃住 ↗</a>` : ""}</article>`,
            )
            .join("") || '<p class="page-status">行程内容暂不可展示</p>'
        }`;
      const mapButton = content.querySelector(".page-map-action");
      if (mapButton) mapButton.onclick = () => onTrip(trip);
    } else if (route.page === "history") {
      content.innerHTML =
        '<div class="history-list"></div><p class="page-status" role="status"></p><button class="loadmore" hidden>更多行程 ↓</button>';
      const list = content.querySelector(".history-list"),
        status = content.querySelector(".page-status"),
        more = content.querySelector(".loadmore");
      let offset = 0;
      const load = async () => {
        more.disabled = true;
        status.textContent = "正在收好你的旅行…";
        try {
          const trips = await api(
            `/api/trips?summary=1&limit=21&offset=${offset}`,
          );
          if (!isCurrent()) return;
          const visible = trips.slice(0, 20);
          list.insertAdjacentHTML(
            "beforeend",
            visible
              .map(
                (trip) =>
                  `<a class="history-item" href="#/history/${encodeURIComponent(trip.id)}"><span>${esc(trip.title)}</span><span class="history-arrow" aria-hidden="true">→</span><small>${esc(trip.request?.start || "")} → ${esc(trip.request?.end || "")}</small></a>`,
              )
              .join(""),
          );
          offset += visible.length;
          status.textContent = offset ? "" : "第一段旅行，从这里开始。";
          more.hidden = trips.length <= 20;
          more.textContent = "更多行程 ↓";
        } catch (error) {
          if (!isCurrent()) return;
          status.textContent = error.message;
          more.hidden = false;
          more.textContent = "重新加载 ↻";
        } finally {
          more.disabled = false;
        }
      };
      list.onclick = (event) => {
        const link = event.target.closest("a");
        if (
          !link ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        navigate(link.getAttribute("href"));
      };
      more.onclick = load;
      await load();
    } else {
      const feature = features[route.page];
      content.innerHTML = `<div class="feature-empty"><span class="tile-icon ${feature.color}" aria-hidden="true">${feature.icon}</span><h2>即将开放</h2><p>${feature.text}</p><button class="primary" data-return-travel>去旅行 ↗</button></div>`;
      content.querySelector("[data-return-travel]").onclick = () =>
        navigate("/home");
    }
  } catch (error) {
    if (!isCurrent()) return;
    content.innerHTML = `<div class="page-status" role="status"><p>${esc(error.message)}</p><button class="primary">重新加载 ↻</button></div>`;
    content.querySelector("button").onclick = () =>
      renderProfilePage({
        route,
        content,
        setTitle,
        api,
        esc,
        isCurrent,
        navigate,
        onTrip,
        onUser,
        onLogout,
      });
  }
}
