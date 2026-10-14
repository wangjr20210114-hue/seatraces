const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const byScore = (points) =>
  [...points].sort(
    (a, b) =>
      (b.score?.total ?? 0) - (a.score?.total ?? 0) || a.id.localeCompare(b.id),
  );
export function scenicMemberMarkup(place) {
  const all = place.children || [],
    ids = new Set(all.map((p) => p.id));
  const nested = (p, depth, seen) => {
    const children =
      depth >= 8
        ? []
        : byScore(
            all.filter(
              (c) =>
                !seen.has(c.id) &&
                (c.parentId === p.id ||
                  (p.id === place.id && !ids.has(c.parentId))),
            ),
          );
    const label = `<span>${esc(p.name)}</span>`;
    if (!children.length) return `<span class="scenic-name">${label}</span>`;
    return `<details class="scenic-tree"><summary>${label}<span class="disclosure" aria-hidden="true">▸</span></summary><div class="scenic-nested">${children.map((c) => nested(c, depth + 1, new Set([...seen, c.id]))).join("")}</div></details>`;
  };
  return `<div class="scenic-entity">${nested(place, 1, new Set([place.id]))}<button class="wish" data-wanted="${esc(place.id)}" aria-label="想去：${esc(place.name)}" aria-pressed="${Boolean(place.ownWanted)}">${place.ownWanted ? "想去 ♥" : "想去 ♡"}</button></div>`;
}
