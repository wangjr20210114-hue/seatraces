import { amapLegUrl } from "./trip-view.js";
import { mainlandEligible } from "./coordinates.js";
const escape = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icons = { lunch: "🍜", dinner: "🍲", stay: "🛏" };
const distance = (n) =>
  n < 1000 ? `${n} 米` : `${(n / 1000).toFixed(1)} 公里`;
const pathFor = (id, day, slot = "", place = "", radius) =>
  "/services/" +
  encodeURIComponent(id) +
  "?" +
  new URLSearchParams({
    day: String(day),
    ...(slot ? { slot } : {}),
    ...(place ? { place } : {}),
    ...(radius ? { radius: String(radius) } : {}),
  });
const fact = (p, key) => {
  const v = p.facts?.[key]?.value;
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
};
const safeUrl = (value) => {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
};
const area = (slot) =>
  slot.kind === "stay" && slot.days.length > 1
    ? `Day ${slot.days[0] + 1}—${slot.days.at(-1) + 1} · 同城住宿`
    : `${slot.anchor.name}附近`;
const selectionText = (s) => s?.candidate?.name || "挑一家喜欢的";
const cache = new Map();
export function clearServiceCache() { cache.clear(); }
export function serviceRecommendations(api, tripId, day, radius) {
  // A short shared flight avoids duplicate requests when opening from the shortcut.
  const key = `map:${tripId}:${day}:${radius || ''}`;
  const existing = cache.get(key);
  if (existing?.expires > Date.now()) return existing.work;
  const work = api(`/api/journey/trips/${encodeURIComponent(tripId)}/services/recommendations`, { day, ...(radius ? { radius } : {}) })
    .catch(e => { cache.delete(key); throw e; });
  cache.set(key, { expires: Date.now() + 30000, work });
  while (cache.size > 30) cache.delete(cache.keys().next().value);
  return work;
}
export function mountTripServices({ element, trip, day, api, navigate }) {
  const key = trip.id + ":" + trip.version + ":" + day;
  element.className = "trip-services-widget";
  element.innerHTML =
    "<header><h3>沿途吃住</h3><span>Day " +
    (day + 1) +
    '</span></header><p class="muted" role="status">正在看看附近…</p>';
  async function load(retry = false) {
    try {
      if (retry) cache.delete(key);
      if (!cache.has(key))
        cache.set(
          key,
          serviceRecommendations(api, trip.id, day).catch((e) => {
            cache.delete(key);
            throw e;
          }),
        );
      while (cache.size > 30) cache.delete(cache.keys().next().value);
      const result = await cache.get(key);
      if (!element.isConnected) return;
      if (result.slots.some((s) => s.status === "unavailable"))
        cache.delete(key);
      element.innerHTML = `<header><h3>沿途吃住</h3><span>Day ${day + 1}</span></header><div class="service-shortcuts">${result.slots.map((s) => `<button data-service="${escape(s.id)}"><span class="service-icon" aria-hidden="true">${icons[s.kind]}</span><span><b>${s.title}</b><strong>${escape(s.selected?.candidate?.name || s.items[0]?.name || "看看附近")}</strong><small>${s.selected?.reviewNeeded ? "行程有变化，重新看看" : s.selected ? "已选好" : s.status === "unavailable" ? "稍后重试" : s.items.length ? "附近推荐" : "暂无附近资料"}</small></span><span aria-hidden="true">›</span></button>`).join("")}</div>${!result.slots.length ? '<p class="muted">安排景点后，这里会推荐附近吃住。</p>' : ""}`;
      element
        .querySelectorAll("[data-service]")
        .forEach(
          (b) =>
            (b.onclick = () =>
              navigate(pathFor(trip.id, day, b.dataset.service))),
        );
    } catch (e) {
      if (!element.isConnected) return;
      element.innerHTML = `<header><h3>沿途吃住</h3></header><p class="muted">${escape(e.message)}</p><button class="inline-action">再试一次 ↻</button>`;
      element.querySelector("button").onclick = () => load(true);
    }
  }
  void load();
}
export async function renderTripServicesPage({
  route,
  content,
  setTitle,
  api,
  isCurrent,
  navigate,
  onTrip,
  cityContext,
}) {
  const day = Number(route.params?.day || 0),
    tripId = route.id;
  const radius = route.params?.radius ? Number(route.params.radius) : undefined;
  const path = (slot = "", place = "", range = radius) =>
    pathFor(tripId, day, slot, place, range);
  setTitle("沿途吃住");
  content.innerHTML = '<p class="page-status" role="status">正在看看附近…</p>';
  try {
    const result = await api(
      "/api/journey/trips/" +
        encodeURIComponent(tripId) +
        "/services/recommendations",
      { day, ...(radius ? { radius } : {}) },
    );
    if (!isCurrent()) return;
    const slot =
      result.slots.find((s) => s.id === route.params?.slot) || result.slots[0];
    if (!slot) {
      content.innerHTML =
        '<p class="page-status">这一天还没有可查询的景点位置。</p>';
      return;
    }
    const candidate = slot.items.find((p) => p.id === route.params?.place);
    const submit = async (button, path, body, method) => {
      button.disabled = true;
      const status = content.querySelector('[role="status"]');
      if (status) status.textContent = "正在收进行程…";
      try {
        const saved = await api(path, body, method);
        cache.clear();
        if (isCurrent()) onTrip(saved.trip);
      } catch (e) {
        if (isCurrent() && status) status.textContent = e.message;
        if (e.status === 409 && isCurrent()) {
          const reload = document.createElement("button");
          reload.className = "inline-action";
          reload.textContent = "重新打开";
          reload.onclick = () =>
            renderTripServicesPage({
              route,
              content,
              setTitle,
              api,
              isCurrent,
              navigate,
              onTrip,
              cityContext,
            });
          status?.append(reload);
        }
      } finally {
        button.disabled = false;
      }
    };
    if (route.params?.place) {
      if (!candidate) throw Error("这家店的推荐已变化，请返回列表重新选择。");
      const input = {
        version: result.version,
        recommendationId: slot.recommendationId,
        placeId: candidate.id,
      };
      const preview = await api(
        "/api/journey/trips/" +
          tripId +
          "/services/" +
          encodeURIComponent(slot.id) +
          "/preview",
        input,
      );
      if (!isCurrent()) return;
      const p = preview.candidate,
        website = safeUrl(fact(p, "website")),
        source = safeUrl(p.sources?.[0]?.url);
      const navPlace = { ...p, country:p.country || p.location?.countryCode || cityContext?.country };
      const nav = mainlandEligible(navPlace)
        ? amapLegUrl(null, navPlace, slot.kind === "stay" ? "balanced" : "walk")
        : null;
      setTitle(slot.kind === "stay" ? "看看这间住宿" : "看看这家店");
      content.innerHTML = `<article class="service-detail"><span class="service-detail-icon" aria-hidden="true">${icons[slot.kind]}</span><span class="eyebrow">${escape(slot.city)} · ${slot.title}</span><h2>${escape(p.name)}</h2><p>${escape(area(slot))} · 直线 ${distance(p.distanceMeters)}</p><div class="service-facts">${[
        ["地址", p.location?.address],
        ["开放时间", fact(p, "openingHours")],
        ["电话", fact(p, "phone")],
        ["入住", fact(p, "checkIn")],
        ["退房", fact(p, "checkOut")],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => `<p><b>${k}</b><span>${escape(v)}</span></p>`)
        .join(
          "",
        )}</div><p class="service-hint">${slot.kind === "stay" ? "先收好住宿备选，价格和房态以店家为准。" : "先收好这家店，营业安排以店家为准。"}</p><div class="service-links">${nav ? `<a class="service-outline" href="${escape(nav)}" rel="noopener">高德导航 ↗</a>` : ""}${website ? `<a class="service-outline" href="${escape(website)}" target="_blank" rel="noopener noreferrer">店家网站 ↗</a>` : ""}${source ? `<a href="${escape(source)}" target="_blank" rel="noopener noreferrer">资料来源 ↗</a>` : ""}</div><button class="primary service-save">选作${slot.title} ✓</button><p role="status" aria-live="polite"></p><button class="inline-action" data-list>再看看其他</button><small class="service-source">OpenStreetMap · ${escape(p.sources?.[0]?.license || "ODbL-1.0")} · 查询 ${escape((p.sources?.[0]?.retrievedAt || "").slice(0, 10))}${slot.status === "snapshot" ? " · 缓存资料" : ""}</small></article>`;
      content.querySelector(".service-save").onclick = (e) =>
        submit(
          e.currentTarget,
          "/api/journey/trips/" +
            tripId +
            "/services/" +
            encodeURIComponent(slot.id),
          input,
          "PUT",
        );
      content.querySelector("[data-list]").onclick = () =>
        navigate(path(slot.id));
      return;
    }
    content.innerHTML = `<div class="service-heading"><span class="eyebrow">EAT & STAY</span><h2>${escape(slot.city)}，顺路歇一歇</h2><p>Day ${day + 1} · ${escape(slot.date)}</p></div><nav class="service-tabs" aria-label="吃住类别">${result.slots.map((s) => `<button data-slot="${escape(s.id)}" aria-pressed="${s.id === slot.id}">${icons[s.kind]} ${s.title}</button>`).join("")}</nav><p class="service-area">${escape(area(slot))} · ${distance(slot.radius)}范围</p>${slot.selected ? `<div class="service-saved"><b>已选 · ${escape(selectionText(slot.selected))}</b>${slot.selected.reviewNeeded ? "<small>行程有变化，建议重新确认</small>" : ""}<button class="inline-action" data-remove>移除选择</button></div>` : ""}<div class="service-list">${slot.items.map((p, i) => `<button class="service-card" data-place="${escape(p.id)}"><span class="service-number">${i + 1}</span><span><b>${escape(p.name)}</b><small>直线 ${distance(p.distanceMeters)} · ${escape(p.reason)}</small>${p.location?.address ? `<small>${escape(p.location.address)}</small>` : ""}</span><span aria-hidden="true">›</span></button>`).join("")}</div>${!slot.items.length ? `<div class="service-empty"><span>${icons[slot.kind]}</span><p>${slot.status === "unavailable" ? "附近资料暂时没加载出来。" : "这个范围还没有收录到合适地点。"}</p><button class="service-outline" data-retry>再找一次 ↻</button></div>` : ""}<p class="service-hint">${slot.status === "snapshot" ? "当前显示缓存资料。" : "按距离与顺路程度推荐。"}${slot.kind === "stay" ? "保存为住宿备选，不代表已经预订。" : "距离为直线估算，实际走法以导航为准。"}</p><p role="status" aria-live="polite"></p><small class="service-source">© OpenStreetMap contributors · ODbL-1.0</small>`;
    content
      .querySelectorAll("[data-slot]")
      .forEach((b) => (b.onclick = () => navigate(path(b.dataset.slot))));
    content
      .querySelectorAll("[data-place]")
      .forEach(
        (b) => (b.onclick = () => navigate(path(slot.id, b.dataset.place))),
      );
    content
      .querySelector("[data-remove]")
      ?.addEventListener("click", (e) =>
        submit(
          e.currentTarget,
          "/api/journey/trips/" +
            tripId +
            "/services/" +
            encodeURIComponent(slot.id),
          { version: result.version },
          "DELETE",
        ),
      );
    const retry = content.querySelector("[data-retry]");
    if (retry) {
      if (slot.status === "unavailable")
        retry.onclick = () =>
          renderTripServicesPage({
            route,
            content,
            setTitle,
            api,
            isCurrent,
            navigate,
            onTrip,
            cityContext,
          });
      else if (slot.radius < 10000) {
        retry.textContent = "找远一点的 ↗";
        retry.onclick = () =>
          navigate(path(slot.id, "", Math.min(10000, slot.radius * 2)));
      } else retry.remove();
    }
  } catch (e) {
    if (!isCurrent()) return;
    content.innerHTML = `<div class="page-status"><p role="status">${escape(e.message)}</p><button class="primary">重新打开列表</button></div>`;
    content.querySelector("button").onclick = () => {
      if (route.params?.place)
        navigate(pathFor(tripId, day, route.params.slot));
      else
        void renderTripServicesPage({
          route,
          content,
          setTitle,
          api,
          isCurrent,
          navigate,
          onTrip,
          cityContext,
        });
    };
  }
}
