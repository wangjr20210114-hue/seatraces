/* 在地图侧栏展示周边服务，处理筛选与地点联动。 */

import { setIconLabel } from './ui-icons.js';
import { serviceRecommendations, clearServiceCache } from "./trip-services.js";
import {
  serviceIcons as icons,
  serviceDistanceText as distance,
} from "./service-order.js";
import { servicePlaceUrl } from "./service-place-link.js";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function mountServiceMapDock({
  route,
  content,
  api,
  isCurrent,
  navigate,
  onScene,
  onTrip,
}) {
  let disposed = false,
    result,
    slot,
    selectedId,
    revision = 0,
    focusRevision = 0,
    busy = false;
  const day = Number(route.params?.day || 0),
    radius = Number(route.params?.radius) || undefined,
    seen = new Set();
  const current = () => !disposed && isCurrent();
  const path = (slotId = "", range = radius) =>
    `/services/${encodeURIComponent(route.id)}?` +
    new URLSearchParams({
      day,
      ...(slotId ? { slot: slotId } : {}),
      ...(range ? { radius: range } : {}),
    });
  const endpoint = (id = slot.id) =>
    `/api/journey/trips/${encodeURIComponent(route.id)}/services/${encodeURIComponent(id)}`;
  const input = (p) => ({
    version: result.version,
    recommendationId: slot.recommendationId,
    placeId: p.id,
  });
  const message = (text) => {
    const n = content.querySelector("[data-feedback]");
    if (n) n.textContent = text;
  };
  const publish = () => current() && onScene(slot, selectedId, focusRevision);
  function loading(value) {
    content.classList.toggle("service-loading", value);
    content.setAttribute("aria-busy", String(value));
    const list = content.querySelector(".service-list");
    if (list) list.inert = value;
    const button = content.querySelector(".service-shuffle");
    if (button) {
      button.disabled = value || !slot?.canRefresh;
      button.setAttribute("aria-label", value ? "正在换一批" : "换一批");
    }
  }
  async function save(button, body, method, id = slot.id) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    message("正在保存…");
    try {
      const saved = await api(endpoint(id), body, method);
      clearServiceCache();
      if (!current()) return;
      onTrip(saved.trip);
      busy = false;
      await load();
    } catch (e) {
      if (current()) message(e.message);
    } finally {
      busy = false;
      button.disabled = false;
    }
  }
  async function select(id, fromMap = false) {
    if (!slot || busy || !current()) return;
    if (!fromMap && selectedId === id) {
      selectedId = undefined;
      ++revision;
      for (const node of content.querySelectorAll(".service-card.is-open")) {
        node.classList.remove("is-open");
        node
          .querySelector("[data-place]")
          .setAttribute("aria-expanded", "false");
        node.querySelector(".service-drawer").inert = true;
        node
          .querySelector(".service-drawer")
          .setAttribute("aria-hidden", "true");
      }
      publish();
      message("");
      return;
    }
    const p =
      slot.items.find((p) => p.id === id) ||
      (slot.selected?.candidate?.id === id ? slot.selected.candidate : null);
    if (!p) return;
    selectedId = id;
    const mine = ++revision;
    ++focusRevision;
    publish();
    let card;
    for (const node of content.querySelectorAll(".service-card")) {
      const active = node.dataset.card === id;
      node.classList.toggle("is-open", active);
      node
        .querySelector("[data-place]")
        .setAttribute("aria-expanded", String(active));
      node.querySelector(".service-drawer").inert = !active;
      node
        .querySelector(".service-drawer")
        .setAttribute("aria-hidden", String(!active));
      if (active) card = node;
    }
    if (!card) return;
    card.scrollIntoView({
      block: "nearest",
      behavior: matchMedia("(prefers-reduced-motion:reduce)").matches
        ? "auto"
        : "smooth",
    });
    const button = card.querySelector("[data-save]");
    const known =
      slot.selected?.candidate?.id === id && !slot.selected.reviewNeeded;
    setIconLabel(button, known ? '已选好' : '选这家', 'check');
    button.disabled = true;
    if (!slot.items.some((x) => x.id === id)) return;
    try {
      await api(endpoint() + "/preview", input(p));
      if (!current() || mine !== revision) return;
      button.disabled = known;
      button.onclick = () => save(button, input(p), "PUT");
      message("");
    } catch (e) {
      if (current() && mine === revision) message(e.message);
    }
  }
  function render() {
    content.innerHTML = `<nav class="service-tabs" aria-label="吃住类别">${result.slots.map((s) => `<button data-slot="${esc(s.id)}" aria-pressed="${s.id === slot.id}">${icons[s.kind]} ${s.title}</button>`).join("")}</nav>
      <div class="service-toolbar"><span class="service-order-label">距离由近到远</span><button class="service-shuffle" ${slot.canRefresh ? "" : "disabled"}><span class="shuffle-label">换一批</span><span class="service-spinner" aria-hidden="true">↻</span></button></div>
      ${[...(slot.selected ? [slot.selected] : []), ...(slot.previousSelections || [])].map((s) => `<div class="service-saved"><b>已选 · ${esc(s.candidate.name)}</b><button class="inline-action" data-remove="${esc(s.slotId || slot.id)}">移除</button></div>`).join("")}
      <div class="service-list">${slot.items
        .map((p, i) => {
          const url = servicePlaceUrl(p);
          return `<article class="service-card" data-card="${esc(p.id)}"><button class="service-card-main" data-place="${esc(p.id)}" aria-expanded="false" aria-controls="service-drawer-${i}"><span class="service-number">${i + 1}</span><span><b>${esc(p.name)}</b><span class="service-distance">直线 ${distance(p.distanceMeters)}</span></span><span class="service-chevron" aria-hidden="true">⌄</span></button><div class="service-drawer" id="service-drawer-${i}" inert aria-hidden="true"><div><div class="service-card-actions"><button class="primary" data-save disabled>选这家 ✓</button>${url ? `<a class="service-outline" href="${esc(url)}" rel="noopener noreferrer">高德查看 ↗</a>` : ""}</div></div></div></article>`;
        })
        .join(
          "",
        )}</div>${!slot.items.length ? `<p>${slot.status === "unavailable" ? "附近暂时没加载出来" : "附近暂无推荐"}</p><button class="service-outline" data-retry>再找一次 ↻</button>` : ""}<p data-feedback role="status" aria-live="polite"></p>`;
    for (const b of content.querySelectorAll("[data-slot]"))
      b.onclick = () => {
        if (!busy && b.dataset.slot !== slot.id) navigate(path(b.dataset.slot));
      };
    for (const b of content.querySelectorAll("[data-place]"))
      b.onclick = () => void select(b.dataset.place);
    for (const b of content.querySelectorAll("[data-remove]"))
      b.onclick = () =>
        save(b, { version: result.version }, "DELETE", b.dataset.remove);
    content.querySelector(".service-shuffle").onclick = () => {
      if (!busy) void load(true);
    };
    const retry = content.querySelector("[data-retry]");
    if (retry)
      retry.onclick = () => {
        if (slot.status !== "unavailable" && slot.radius < 10000)
          navigate(path(slot.id, Math.min(10000, slot.radius * 2)));
        else {
          clearServiceCache();
          void load();
        }
      };
    publish();
  }
  async function load(refresh = false) {
    const mine = ++revision;
    busy = true;
    if (!refresh)
      content.innerHTML =
        '<div class="service-initial-loading" role="status"><span class="service-spinner" aria-hidden="true">↻</span>正在看看附近…</div>';
    loading(true);
    if (refresh) message("正在换一批…");
    let reopen;
    try {
      let target = slot?.id || route.params?.slot || "dining:" + day;
      if (/^(lunch|dinner):/.test(target)) target = "dining:" + day;
      if (target === "stay") {
        const summary = await api(
          `/api/journey/trips/${encodeURIComponent(route.id)}/services`,
        );
        target = summary.days[day]?.slots.find((s) => s.kind === "stay")?.id;
      }
      const response = await serviceRecommendations(
        api,
        route.id,
        day,
        radius,
        {
          activeSlot: target,
          sort: "distance",
          ...(refresh
            ? { refresh: true, excludePlaceIds: [...seen].slice(-200) }
            : {}),
        },
      );
      if (!current() || mine !== revision) return;
      const next =
        response.slots.find((s) => s.id === target) || response.slots[0];
      if (refresh && next?.status === "unavailable")
        throw Error("暂时没换成功，请再试一次");
      result = response;
      slot = next;
      if (!slot) {
        content.innerHTML = '<p class="page-status">当天暂无景点</p>';
        return;
      }
      slot.items.forEach((p) => seen.add(p.id));
      selectedId = undefined;
      render();
      if (!refresh && route.params?.place) reopen = route.params.place;
    } catch (e) {
      if (current() && mine === revision) {
        if (refresh && slot) message(e.message);
        else {
          content.innerHTML = `<p role="status">${esc(e.message)}</p><button class="primary" data-load>重试 ↻</button>`;
          content.querySelector("[data-load]").onclick = () => {
            clearServiceCache();
            void load();
          };
        }
      }
    } finally {
      if (mine === revision) {
        busy = false;
        if (current()) loading(false);
      }
    }
    if (reopen && current()) void select(reopen);
  }
  void load();
  return {
    select,
    dispose() {
      disposed = true;
      ++revision;
    },
  };
}
