import { toGcj, mainlandEligible } from "./coordinates.js";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]));
export function uniqueCities(result, limit = 18) {
  const seen = new Set();
  return result.filter(c => { const key = c.country + ":" + c.name.replace(/市$/, ""); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, limit);
}
export function boundarySvg(data, groups, selected, district = "") {
  const b = data.boundary,
    rings =
      b.districts.find((d) => d.name === district)?.rings || b.cityRings,
    points = [
      ...rings.flat(),
      ...groups.map((g) => clusterPoint(g, data.city)),
    ];
  if (!points.length) return "";
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  for (const p of points) {
    w = Math.min(w, p[0]);
    s = Math.min(s, p[1]);
    e = Math.max(e, p[0]);
    n = Math.max(n, p[1]);
  }
  const cos = Math.cos((data.city.lat * Math.PI) / 180),
    scale = Math.min(
      334 / Math.max((e - w) * cos, 0.02),
      314 / Math.max(n - s, 0.02),
    ),
    dx = (360 - (e - w) * cos * scale) / 2,
    dy = (340 - (n - s) * scale) / 2,
    xy = (p) => [dx + (p[0] - w) * cos * scale, dy + (n - p[1]) * scale],
    path = (rs) =>
      rs
        .map(
          (r) =>
            "M" +
            r
              .map((p) =>
                xy(p)
                  .map((v) => v.toFixed(1))
                  .join(","),
              )
              .join("L") +
            "Z",
        )
        .join(""),
    colors = ["#ffdf8e", "#bfe7b5", "#c7dbf5", "#ffc8ac", "#e4d6f5", "#c7ece1"];
  // Anchors are actual representative POIs. Never displace them to avoid overlap.
  const symbols = groups.map((g) => {
    const anchor = xy(clusterPoint(g, data.city));
    return { g, anchor, x: anchor[0], y: anchor[1] };
  });
  return `<svg class="city-map" viewBox="0 0 360 340" role="group" aria-label="${esc(data.city.name)}区县与景点片区">${rings.length ? `<path d="${path(rings)}" fill="#faf3d8" class="district-path"/>` : ""}${b.districts.map((d, i) => `<path d="${path(d.rings)}" fill="${colors[i % colors.length]}" class="district-path"/><text class="district-name" x="${xy(d.center)[0]}" y="${xy(d.center)[1]}">${esc(d.name)}</text>`).join("")}${groups
    .map((g, i) => {
      const { x, y, anchor } = symbols[i];
      return `<g class="cluster-dot" data-cluster="${g.id}" transform="translate(${x},${y})" tabindex="0" role="button" aria-label="片区${g.number}，${esc(g.name)}，${g.memberCount}处" aria-pressed="${selected.includes(g.id)}"><title>${esc(g.anchor?.name || g.name)} · 片区${g.number}</title><circle r="13"/><text>${g.number}</text></g>`;
    })
    .join("")}</svg>`;
}
function clusterPoint(group, city) {
  const p = { ...(group.anchor || group.center), country: city.country };
  return mainlandEligible(p) ? toGcj(p).split(",").map(Number) : [p.lng, p.lat];
}
