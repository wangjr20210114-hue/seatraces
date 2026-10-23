/* 计算步行进度与路线位置，生成导航链接。 */

const radians = x => x * Math.PI / 180;
export const validPoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
export function metersBetween(a, b) {
  const h = Math.sin(radians(b[0] - a[0]) / 2) ** 2 + Math.cos(radians(a[0])) * Math.cos(radians(b[0])) * Math.sin(radians(b[1] - a[1]) / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function walkingGeometry(leg) {
  if (leg?.mode !== 'walk') return null;
  const steps = leg.steps?.length ? leg.steps : [{ instruction: leg.instruction, polyline: leg.polyline }];
  const edges = [];
  let total = 0, previousEnd = null;
  for (const [stepIndex, step] of steps.entries()) {
    const points = step.polyline || [];
    if (points.length < 2 || !points.every(validPoint)) return null;
    if (previousEnd && metersBetween(previousEnd, points[0]) > 20) return null;
    for (let i = 1; i < points.length; i++) {
      const length = metersBetween(points[i - 1], points[i]);
      if (length > 0.01) {
        edges.push({ a: points[i - 1], b: points[i], length, along: total, stepIndex });
        total += length;
      }
    }
    previousEnd = points.at(-1);
  }
  return edges.length ? { edges, total, steps, end: previousEnd } : null;
}

function project(point, edge) {
  const scale = Math.cos(radians(point[0]));
  const xy = p => [radians(p[1] - point[1]) * scale * 6371008.8, radians(p[0] - point[0]) * 6371008.8];
  const a = xy(edge.a), b = xy(edge.b), dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / (dx * dx + dy * dy)));
  return { distance: Math.hypot(a[0] + dx * t, a[1] + dy * t), along: edge.along + edge.length * t, stepIndex: edge.stepIndex };
}

export function walkingProgress(geometry, fix, previous = null) {
  if (!geometry) return { status: 'geometry_unavailable' };
  const point = [fix.latitude, fix.longitude];
  if (!validPoint(point) || !Number.isFinite(fix.accuracy) || fix.accuracy < 0 || fix.accuracy > 50)
    return { status: 'low_accuracy' };
  const matches = geometry.edges.map(e => project(point, e)).sort((a, b) => a.distance - b.distance);
  const nearest = matches[0];
  if (nearest.distance > Math.max(30, fix.accuracy * 2)) return { status: 'off_route', distanceFromRoute: nearest.distance };
  const candidates = matches.filter(p => p.distance <= nearest.distance + Math.min(12, fix.accuracy / 2 + 3));
  const reference = previous?.along ?? 0;
  candidates.sort((a, b) => Math.abs(a.along - reference) - Math.abs(b.along - reference));
  const chosen = candidates[0];
  if (previous && Number.isFinite(fix.timestamp) && Number.isFinite(previous.timestamp)) {
    const seconds = Math.max(0, (fix.timestamp - previous.timestamp) / 1000);
    if (Math.abs(chosen.along - previous.along) > 5 * seconds + fix.accuracy * 2 + 30)
      return { status: 'uncertain_jump' };
  }
  const remainingMeters = Math.max(0, geometry.total - chosen.along);
  return { status: 'on_route', along: chosen.along, timestamp: fix.timestamp, remainingMeters,
    stepIndex: chosen.stepIndex, instruction: geometry.steps[chosen.stepIndex].instruction,
    nextInstruction: geometry.steps[chosen.stepIndex + 1]?.instruction || null,
    progress: chosen.along / geometry.total,
    nearEnd: remainingMeters <= 30 && metersBetween(point, geometry.end) <= 25 };
}

export function navigationUrl({ from, to, mode, leg = null, mainland = false, convertToGcj, selections = {} }) {
  const a = leg ? leg.start : [Number(from.lat), Number(from.lng)];
  const b = leg ? leg.end : [Number(to.lat), Number(to.lng)];
  if (!validPoint(a) || !validPoint(b)) return null;
  const kind = leg?.mode || mode;
  if (mainland) {
    const endpoint=(point,choice)=>{
      if(!leg&&choice?.provider==='amap'){
        const coords=String(choice.location||'').split(',').map(Number);
        if(coords.length!==2||!validPoint([coords[1],coords[0]]))return null;
        return coords.map(value=>value.toFixed(6)).join(',');
      }
      return convertToGcj({lat:point[0],lng:point[1]});
    };
    const start=endpoint(a,selections?.from),end=endpoint(b,selections?.to);if(!start||!end)return null;
    const params = new URLSearchParams({
      from: start + ',起点',
      to: end + ',终点',
      mode: ({ walk: 'walk', walking: 'walk', cycle: 'ride', cycling: 'ride', drive: 'car', driving: 'car', taxi: 'car' })[kind] || 'bus',
      src: 'SeaTraces', callnative: '1'
    });
    return 'https://uri.amap.com/navigation?' + params;
  }
  const params=new URLSearchParams({ api: '1', origin: a.join(','), destination: b.join(','),
    travelmode: ({ walk: 'walking', walking: 'walking', cycle: 'bicycling', cycling: 'bicycling', drive: 'driving', driving: 'driving', taxi: 'driving' })[kind] || 'transit' });
  if(!leg){for(const [key,ref] of [['origin_place_id',selections?.from],['destination_place_id',selections?.to]])if(ref?.provider==='google'&&ref.id)params.set(key,ref.id);}
  return 'https://www.google.com/maps/dir/?'+params;
}
