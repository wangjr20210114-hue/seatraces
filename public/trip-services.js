import { amapLegUrl } from "./trip-view.js";
import { mainlandEligible } from "./coordinates.js";
import {
  serviceIcons as icons,
  servicePriceText,
  serviceDistanceText,
} from "./service-order.js";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const cache = new Map();
export function clearServiceCache() {
  cache.clear();
}
export function serviceRecommendations(api, tripId, day, radius, options = {}) {
  const { refresh = false, ...stable } = options;
  const key = JSON.stringify([tripId, day, radius, stable]);
  const old = cache.get(key);
  if (!refresh && old?.expires > Date.now()) return old.work;
  const work = api(
    `/api/journey/trips/${encodeURIComponent(tripId)}/services/recommendations`,
    {
      day,
      groupMeals: true,
      ...(radius ? { radius } : {}),
      ...options,
    },
  ).catch((e) => {
    cache.delete(key);
    throw e;
  });
  if (!refresh) cache.set(key, { expires: Date.now() + 30000, work });
  while (cache.size > 30) cache.delete(cache.keys().next().value);
  return work;
}
const pathFor = (id, day, slot = "", place = "", radius, rec = "") =>
  `/services/${encodeURIComponent(id)}?` +
  new URLSearchParams({
    day,
    ...(slot ? { slot } : {}),
    ...(place ? { place } : {}),
    ...(radius ? { radius } : {}),
    ...(rec ? { recommendation: rec } : {}),
  });
export function mountTripServices({ element, trip, day, api, navigate }) {
  element.className = "trip-services-widget";
  // No merchant search or paid price request until the user opens a category.
  const choices = trip.plan.services || {};
  const dining =
    choices["dining:" + day] ||
    choices["lunch:" + day] ||
    choices["dinner:" + day];
  const stay = Object.values(choices).find(
    (s) => s.kind === "stay" && s.days?.includes(day),
  );
  element.innerHTML = `<header><h3>附近吃住</h3></header><div class="service-shortcuts">${[
    { id: "dining:" + day, title: "餐饮", kind: "dining", selected: dining },
    { id: stay?.slotId || "", title: "住宿", kind: "stay", selected: stay },
  ]
    .map(
      (s) =>
        `<button data-service="${esc(s.id)}" data-kind="${s.kind}"><span class="service-icon">${icons[s.kind]}</span><span><b>${s.title}</b>${s.selected ? `<strong>${esc(s.selected.candidate.name)}</strong>` : ""}</span><span>›</span></button>`,
    )
    .join("")}</div>`;
  for (const b of element.querySelectorAll("[data-service]"))
    b.onclick = () =>
      navigate(
        pathFor(
          trip.id,
          day,
          b.dataset.service || (b.dataset.kind === "stay" ? "stay" : ""),
        ),
      );
}
const fact = (p, k) => {
  const v = p.facts?.[k]?.value;
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
};
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
    radius = Number(route.params?.radius) || undefined;
  setTitle("附近吃住");
  content.innerHTML = '<p class="page-status" role="status">正在加载…</p>';
  try {
    // Read summary only: details reuse the selected recommendation, without fetching another batch.
    const summary = await api(
      `/api/journey/trips/${encodeURIComponent(route.id)}/services`,
    );
    if (!isCurrent()) return;
    if (!route.params?.place) {
      navigate(pathFor(route.id, day, route.params?.slot));
      return;
    }
    const slotId = route.params.slot;
    let recommendationId = route.params.recommendation;
    if (!recommendationId) {
      const list = await serviceRecommendations(api, route.id, day, radius, {
        activeSlot: slotId,
      });
      recommendationId = list.slots.find(
        (s) => s.id === slotId,
      )?.recommendationId;
    }
    const input = {
      version: summary.version,
      recommendationId,
      placeId: route.params.place,
    };
    const endpoint = `/api/journey/trips/${encodeURIComponent(route.id)}/services/${encodeURIComponent(slotId)}`;
    const preview = await api(endpoint + "/preview", input);
    if (!isCurrent()) return;
    const p = preview.candidate,
      slot = preview.slot;
    const navPlace = {
      ...p,
      country: p.country || p.location?.countryCode || cityContext?.country,
    };
    const nav = mainlandEligible(navPlace)
      ? amapLegUrl(null, navPlace, slot.kind === "stay" ? "balanced" : "walk")
      : null;
    setTitle(slot.kind === "stay" ? "住宿" : "餐饮");
    content.innerHTML = `<article class="service-detail"><div class="service-detail-top"><span class="service-detail-icon">${icons[slot.kind]}</span><div><h2>${esc(p.name)}</h2><div class="service-metrics"><span>${esc(servicePriceText(p))}</span><span>直线 ${serviceDistanceText(p.distanceMeters)}</span></div></div></div><div class="service-facts">${[
      ["地址", p.location?.address],
      ["营业时间", fact(p, "openingHours")],
      ["电话", fact(p, "phone")],
      ["入住", fact(p, "checkIn")],
      ["退房", fact(p, "checkOut")],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `<p><b>${k}</b><span>${esc(v)}</span></p>`)
      .join(
        "",
      )}</div><div class="service-detail-actions">${nav ? `<a class="service-outline" href="${esc(nav)}" rel="noopener">高德导航 ↗</a>` : ""}<button class="primary service-save">选这家 ✓</button></div><p role="status" aria-live="polite"></p></article>`;
    content.querySelector(".service-save").onclick = async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        const saved = await api(endpoint, input, "PUT");
        clearServiceCache();
        if (isCurrent()) onTrip(saved.trip);
      } catch (error) {
        if (isCurrent())
          content.querySelector('[role="status"]').textContent = error.message;
      } finally {
        b.disabled = false;
      }
    };
  } catch (e) {
    if (!isCurrent()) return;
    content.innerHTML = `<div class="page-status"><p role="status">${esc(e.message)}</p><button class="primary">返回列表</button></div>`;
    content.querySelector("button").onclick = () =>
      navigate(pathFor(route.id, day, route.params?.slot));
  }
}
