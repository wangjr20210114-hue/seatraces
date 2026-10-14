import { serviceRecommendations, clearServiceCache } from "./trip-services.js";
import {
  serviceIcons as icons,
  servicePriceText,
  serviceDistanceText as distance,
  serviceComparator,
} from "./service-order.js";
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
    busy = false,
    sort = "comprehensive";
  const day = Number(route.params?.day || 0),
    radius = Number(route.params?.radius) || undefined,
    seen = new Set();
  const current = () => !disposed && isCurrent();
  const path = (slotId = "", place = "", range = radius) =>
    `/services/${encodeURIComponent(route.id)}?` +
    new URLSearchParams({
      day,
      ...(slotId ? { slot: slotId } : {}),
      ...(place ? { place, recommendation: slot.recommendationId } : {}),
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
  const publish = () => current() && onScene(slot, selectedId);
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
  async function select(id) {
    if (!slot || busy || !current()) return;
    const p =
      slot.items.find((p) => p.id === id) ||
      (slot.selected?.candidate?.id === id ? slot.selected.candidate : null);
    if (!p) return;
    selectedId = id;
    const mine = ++revision;
    publish();
    for (const b of content.querySelectorAll("[data-place]"))
      b.setAttribute("aria-pressed", b.dataset.place === id);
    const box = content.querySelector(".service-pick"),
      known = slot.selected?.candidate?.id === id;
    box.hidden = false;
    box.innerHTML = `<h2>${esc(p.name)}</h2><div class="service-metrics"><span>${esc(servicePriceText(p))}</span><span>直线 ${distance(p.distanceMeters)}</span></div><div class="service-pick-actions"><button class="primary" data-save disabled>${known ? "已选好 ✓" : "选这家 ✓"}</button>${slot.items.some((x) => x.id === id) ? '<button class="service-outline" data-detail>详情 ↗</button>' : ""}</div>`;
    box
      .querySelector("[data-detail]")
      ?.addEventListener("click", () => navigate(path(slot.id, id)));
    box.scrollIntoView({
      block: "nearest",
      behavior: matchMedia("(prefers-reduced-motion:reduce)").matches
        ? "auto"
        : "smooth",
    });
    if (!slot.items.some((x) => x.id === id)) return;
    try {
      await api(endpoint() + "/preview", input(p));
      if (!current() || mine !== revision) return;
      const b = box.querySelector("[data-save]");
      b.disabled = known && !slot.selected.reviewNeeded;
      b.onclick = () => save(b, input(p), "PUT");
      message("");
    } catch (e) {
      if (current() && mine === revision) message(e.message);
    }
  }
  function render() {
    content.innerHTML = `<nav class="service-tabs" aria-label="吃住类别">${result.slots.map((s) => `<button data-slot="${esc(s.id)}" aria-pressed="${s.id === slot.id}">${icons[s.kind]} ${s.title}</button>`).join("")}</nav><div class="service-toolbar"><div class="service-sort" role="group" aria-label="排序">${[
      ["comprehensive", "综合"],
      ["distance", "距离"],
      ["price", "价格"],
    ]
      .map(
        ([key, name]) =>
          `<button data-sort="${key}" aria-pressed="${key === sort}">${name}</button>`,
      )
      .join(
        "",
      )}</div><button class="service-shuffle" ${slot.canRefresh ? "" : "disabled"}>换一批 ↻</button></div><article class="service-pick" hidden></article>${[...(slot.selected ? [slot.selected] : []), ...(slot.previousSelections || [])].map((s) => `<div class="service-saved"><b>已选 · ${esc(s.candidate.name)}</b><button class="inline-action" data-remove="${esc(s.slotId || slot.id)}">移除</button></div>`).join("")}<div class="service-list">${slot.items.map((p, i) => `<button class="service-card" data-place="${esc(p.id)}" aria-pressed="${p.id === selectedId}"><span class="service-number">${i + 1}</span><span><b>${esc(p.name)}</b><span class="service-metrics"><span>${esc(servicePriceText(p))}</span><span>直线 ${distance(p.distanceMeters)}</span></span></span><span aria-hidden="true">›</span></button>`).join("")}</div>${!slot.items.length ? `<p>${slot.status === "unavailable" ? "附近暂时没加载出来" : "附近暂无推荐"}</p><button class="service-outline" data-retry>再找一次 ↻</button>` : ""}<p data-feedback role="status" aria-live="polite"></p>`;
    for (const b of content.querySelectorAll("[data-slot]"))
      b.onclick = () => {
        if (!busy && b.dataset.slot !== slot.id) navigate(path(b.dataset.slot));
      };
    for (const b of content.querySelectorAll("[data-place]"))
      b.onclick = () => select(b.dataset.place);
    for (const b of content.querySelectorAll("[data-remove]"))
      b.onclick = () =>
        save(b, { version: result.version }, "DELETE", b.dataset.remove);
    for (const b of content.querySelectorAll("[data-sort]"))
      b.onclick = () => {
        if (busy) return;
        sort = b.dataset.sort;
        slot.items.sort(serviceComparator(sort));
        render();
        publish();
      };
    content.querySelector(".service-shuffle").onclick = () => {
      if (!busy) void load(true);
    };
    const retry = content.querySelector("[data-retry]");
    if (retry)
      retry.onclick = () => {
        if (slot.status !== "unavailable" && slot.radius < 10000)
          navigate(path(slot.id, "", Math.min(10000, slot.radius * 2)));
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
    if (refresh) {
      content.querySelector(".service-shuffle").disabled = true;
      message("正在换一批…");
    } else
      content.innerHTML =
        '<p class="page-status" role="status">正在看看附近…</p>';
    try {
      let target = slot?.id || route.params?.slot || "dining:" + day;
      // Old shared links still open the unified dining category.
      if (/^(lunch|dinner):/.test(target)) target = "dining:" + day;
      if (target === "stay") {
        const summary = await api(
          `/api/journey/trips/${encodeURIComponent(route.id)}/services`,
        );
        target = summary.days[day]?.slots.find((s) => s.kind === "stay")?.id;
      }
      result = await serviceRecommendations(api, route.id, day, radius, {
        activeSlot: target,
        sort,
        ...(refresh
          ? { refresh: true, excludePlaceIds: [...seen].slice(-200) }
          : {}),
      });
      if (!current() || mine !== revision) return;
      slot = result.slots.find((s) => s.id === target) || result.slots[0];
      if (!slot) {
        content.innerHTML = '<p class="page-status">当天暂无景点</p>';
        return;
      }
      slot.items.forEach((p) => seen.add(p.id));
      selectedId = undefined;
      render();
    } catch (e) {
      if (current() && mine === revision) {
        content.innerHTML = `<p role="status">${esc(e.message)}</p><button class="primary" data-load>重试 ↻</button>`;
        content.querySelector("[data-load]").onclick = () => {
          clearServiceCache();
          void load();
        };
      }
    } finally {
      if (mine === revision) busy = false;
    }
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
