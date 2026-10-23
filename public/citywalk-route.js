/* 计算 CityWalk 站点顺序，整理路线名称和距离。 */

export const walkName = place => /[\u3400-\u9fff]/.test(place.name) ? place.name : (place.aliases || []).find(name => /[\u3400-\u9fff]/.test(name)) || place.name;
export function metres(a, b) {
  const rad = Math.PI / 180, dlat = (b.lat - a.lat) * rad, dlng = (b.lng - a.lng) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export const routeMetres = stops => stops.slice(1).reduce((sum, p, i) => sum + metres(stops[i], p), 0);
export function orderWalk(points, startId = points[0]?.id) {
  const unique = [...new Map(points.map(p => [p.id, p])).values()];
  if (unique.some(p => !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180)) throw Error('景点坐标不可用');
  if (unique.length < 2) return unique;
  const start = unique.find(p => p.id === startId) || unique[0];
  const original = [start, ...unique.filter(p => p !== start)], remaining = original.slice(1), greedy = [start];
  while (remaining.length) {
    let best = 0;
    for (let i = 1; i < remaining.length; i++) if (metres(greedy.at(-1), remaining[i]) < metres(greedy.at(-1), remaining[best])) best = i;
    greedy.push(remaining.splice(best, 1)[0]);
  }
  let result = routeMetres(original) < routeMetres(greedy) ? original : greedy;
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    for (let i = 1; i < result.length - 1; i++) for (let j = i + 1; j < result.length; j++) {
      const before = metres(result[i - 1], result[i]) + (j + 1 < result.length ? metres(result[j], result[j + 1]) : 0);
      const after = metres(result[i - 1], result[j]) + (j + 1 < result.length ? metres(result[i], result[j + 1]) : 0);
      if (after < before - 0.01) { result.splice(i, j - i + 1, ...result.slice(i, j + 1).reverse()); changed = true; }
    }
    if (!changed) break;
  }
  return result;
}
