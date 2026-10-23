/* 根据站点坐标生成路线示意曲线。 */

export function schematicConnections(stops) {
  return stops.slice(1).flatMap((to, i) => {
    const from = stops[i];
    const [x, y] = from.position,
      [tx, ty] = to.position;
    if (![x, y, tx, ty].every(Number.isFinite)) return [];
    const dx = ((tx - x + 540) % 360) - 180,
      dy = ty - y;
    const path = Array.from({ length: 25 }, (_, n) => {
      const t = n / 24,
        bend = Math.sin(Math.PI * t) * 0.12;
      return [x + dx * t - dy * bend, y + dy * t + dx * bend];
    });
    return [{ from: from.id, to: to.id, path, source: "schematic" }];
  });
}
