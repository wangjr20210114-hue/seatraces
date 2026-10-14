import { serviceIcons as icons } from "./service-order.js";
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
  // Read saved choices only; search starts when the user opens a category.
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
