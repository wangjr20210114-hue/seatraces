import { renderAccountPage } from "./account-page.js";
import {renderPersonalPage} from './personal-center.js';
import {publishRoute} from './discovery.js';

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
  if (!['account','history'].includes(route.page)) return renderPersonalPage({route,content,setTitle,api,isCurrent,navigate});
  setTitle(
    route.page === "account"
      ? "我的账号"
      : route.page === "history"
        ? route.id
          ? "旅行详情"
          : "历史行程"
        : "我的",
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
      content.innerHTML = `<div class="trip-detail-heading"><span class="eyebrow">MY JOURNEY</span><h2>${esc(trip.title)}</h2><button class="route-share" data-share-trip>分享 ↗</button><p class="muted">${esc(trip.request?.start || "")} — ${esc(trip.request?.end || "")}</p><p class="share-status" role="status"></p></div>
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
      content.querySelector('[data-share-trip]').onclick=e=>publishRoute({button:e.currentTarget,api,kind:'journey',id:trip.id,navigate,toast:message=>{if(isCurrent())content.querySelector('.share-status').textContent=message;}});
    } else if (route.page === "history") {
      content.innerHTML =
        '<a class="inline-action" href="#/report">旅行报告 ↗</a><div class="history-list"></div><p class="page-status" role="status"></p><button class="loadmore" hidden>更多行程 ↓</button>';
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
