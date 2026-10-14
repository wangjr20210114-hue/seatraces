import { serviceRecommendations, clearServiceCache } from "./trip-services.js";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icons = { lunch: "🍜", dinner: "🍲", stay: "🛏" };
const distance = (n) =>
  Number.isFinite(n)
    ? n < 1000
      ? `${Math.round(n)} 米`
      : `${(n / 1000).toFixed(1)} 公里`
    : "";

// Reuses the existing recommendation/preview/save contracts; map state is local.
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
    selectRevision = 0,
    busy = false;
  const day = Number(route.params?.day || 0),
    radius = Number(route.params?.radius) || undefined;
  const current = () => !disposed && isCurrent();
  const path = (slotId = "", place = "", range = radius) =>
    `/services/${encodeURIComponent(route.id)}?` +
    new URLSearchParams({
      day,
      ...(slotId ? { slot: slotId } : {}),
      ...(place ? { place } : {}),
      ...(range ? { radius: range } : {}),
    });
  const endpoint = () =>
    `/api/journey/trips/${encodeURIComponent(route.id)}/services/${encodeURIComponent(slot.id)}`;
  const input = (p) => ({
    version: result.version,
    recommendationId: slot.recommendationId,
    placeId: p.id,
  });
  const message = (text) => {
    const node = content.querySelector("[data-feedback]");
    if (node) node.textContent = text;
  };
  const publish = () => current() && onScene(slot, selectedId);
  async function save(button, body, method) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    message("正在收进行程…");
    try {
      const saved = await api(endpoint(), body, method);
      clearServiceCache();
      if (!current()) return;
      onTrip(saved.trip);
      // Refresh the version and recommendation snapshot, staying on the same map.
      busy = false;
      await load();
      message(method === "DELETE" ? "已移除选择" : "已收进行程 ✓");
    } catch (e) {
      if (current()) {
        message(e.message);
        if (e.status === 409) addReload();
      }
    } finally {
      busy = false;
      button.disabled = false;
    }
  }
  function addReload() {
    if (content.querySelector("[data-reload]")) return;
    const b = document.createElement("button");
    b.className = "inline-action";
    b.dataset.reload = "1";
    b.textContent = "刷新推荐 ↻";
    b.onclick = () => {
      clearServiceCache();
      void load();
    };
    content.querySelector("[data-feedback]")?.after(b);
  }
  async function select(id, fromMap = false) {
    if (!slot || busy || !current()) return;
    const p =
      slot.items.find((p) => p.id === id) ||
      (slot.selected?.candidate?.id === id ? slot.selected.candidate : null);
    if (!p) return;
    selectedId = id;
    const revision = ++selectRevision;
    publish();
    for (const b of content.querySelectorAll("[data-place]"))
      b.setAttribute("aria-pressed", b.dataset.place === id);
    const box = content.querySelector(".service-pick");
    box.hidden = false;
    const known = slot.selected?.candidate?.id === id;
    box.innerHTML = `<h2>${icons[slot.kind]} ${esc(p.name)}</h2><p>${distance(p.distanceMeters) ? "直线 " + distance(p.distanceMeters) + " · " : ""}${esc(p.reason || slot.anchor.name + "附近")}</p><div class="service-pick-actions"><button class="primary" data-save disabled>${known ? "已选好 ✓" : "选这家 ✓"}</button>${slot.items.some((x) => x.id === id) ? '<button class="inline-action" data-detail>详情 ↗</button>' : ""}</div><p data-feedback role="status" aria-live="polite">${known ? (slot.selected.reviewNeeded ? "行程有变化，请重新确认" : "已收进行程") : "正在确认资料…"}</p>`;
    box
      .querySelector("[data-detail]")
      ?.addEventListener("click", () => navigate(path(slot.id, id)));
    box.scrollIntoView({
        block: "nearest",
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    if (!slot.items.some((x) => x.id === id)) return;
    try {
      await api(endpoint() + "/preview", input(p));
      if (!current() || revision !== selectRevision) return;
      const b = box.querySelector("[data-save]");
      b.disabled = known && !slot.selected.reviewNeeded;
      b.onclick = () => save(b, input(p), "PUT");
      message(
        known
          ? slot.selected.reviewNeeded
            ? "确认后可重新保存"
            : "已收进行程"
          : slot.kind === "stay"
            ? "保存住宿备选，不代表预订。"
            : "营业安排以店家为准。",
      );
    } catch (e) {
      if (current() && revision === selectRevision) {
        message(e.message);
        if (e.status === 409) addReload();
      }
    }
  }
  async function load() {
    ++selectRevision;
    content.innerHTML =
      '<p class="page-status" role="status">正在看看附近…</p>';
    try {
      result = await serviceRecommendations(api, route.id, day, radius);
      if (!current()) return;
      slot =
        result.slots.find((s) => s.id === route.params?.slot) ||
        result.slots[0];
      if (!slot) {
        content.innerHTML =
          '<p class="page-status">这一天还没有可查询的景点位置。</p>';
        return;
      }
      selectedId = slot.selected?.candidate?.id;
      content.innerHTML = `<nav class="service-tabs" aria-label="吃住类别">${result.slots.map((s) => `<button data-slot="${esc(s.id)}" aria-pressed="${s.id === slot.id}">${icons[s.kind]} ${s.title}</button>`).join("")}</nav><p class="service-area">Day ${day + 1} · ${esc(slot.kind === "stay" && slot.days.length > 1 ? `Day ${slot.days[0] + 1}—${slot.days.at(-1) + 1} 同城住宿` : slot.anchor.name + "附近")} · ${distance(slot.radius)}</p><article class="service-pick" hidden></article>${slot.selected ? `<div class="service-saved"><b>已选 · ${esc(slot.selected.candidate.name)}</b><button class="inline-action" data-remove>移除选择</button></div>` : ""}<div class="service-list">${slot.items.map((p, i) => `<button class="service-card" data-place="${esc(p.id)}" aria-pressed="${p.id === selectedId}"><span class="service-number">${i + 1}</span><span><b>${esc(p.name)}</b><small>直线 ${distance(p.distanceMeters)} · ${esc(p.reason)}</small></span><span aria-hidden="true">↗</span></button>`).join("")}</div>${!slot.items.length ? `<p>${slot.status === "unavailable" ? "附近资料暂时没加载出来。" : "这附近暂未收录合适地点。"}</p><button class="service-outline" data-retry>再找一次 ↻</button><p data-feedback role="status"></p>` : ""}<p class="service-hint">${slot.status === "snapshot" ? "当前显示缓存资料。" : ""}虚线仅表示与景点的位置关系。</p><small class="service-source">© OpenStreetMap contributors · ODbL-1.0</small>`;
      for (const b of content.querySelectorAll("[data-slot]"))
        b.onclick = () => {
          if (!busy && b.dataset.slot !== slot.id)
            navigate(path(b.dataset.slot));
        };
      for (const b of content.querySelectorAll("[data-place]"))
        b.onclick = () => select(b.dataset.place);
      content
        .querySelector("[data-remove]")
        ?.addEventListener("click", (e) =>
          save(e.currentTarget, { version: result.version }, "DELETE"),
        );
      const retry = content.querySelector("[data-retry]");
      if (retry)
        retry.onclick = () => {
          if (slot.status === "unavailable" || slot.radius >= 10000) {
            clearServiceCache();
            void load();
          } else navigate(path(slot.id, "", Math.min(10000, slot.radius * 2)));
        };
      if (retry && slot.status !== "unavailable" && slot.radius < 10000)
        retry.textContent = "找远一点的 ↗";
      publish();
      if (selectedId) void select(selectedId);
    } catch (e) {
      if (!current()) return;
      content.innerHTML = `<p role="status">${esc(e.message)}</p><button class="primary">再试一次 ↻</button>`;
      content.querySelector("button").onclick = () => {
        clearServiceCache();
        void load();
      };
    }
  }
  void load();
  return {
    select,
    dispose() {
      disposed = true;
      ++selectRevision;
    },
  };
}
