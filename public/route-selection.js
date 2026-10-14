import { mainlandEligible } from './coordinates.js';

export function chooseRoutingCandidate(place, candidate, provider) {
  if (!['amap', 'google'].includes(provider) || !candidate?.routeToken || !Number.isFinite(Date.parse(candidate.expiresAt)))
    throw Error('这个候选缺少可用的路线信息，请重新匹配。');
  return { ...place, routingChoice: { token: candidate.routeToken, expiresAt: candidate.expiresAt,
    provider, id: candidate.id, name: candidate.name } };
}

export function selectedRouteTokens(from, to, now = Date.now()) {
  const provider = mainlandEligible(from) && mainlandEligible(to) ? 'amap' : 'google';
  const body = {};
  for (const [which, place] of [['from', from], ['to', to]]) {
    const selected = place.routingChoice;
    if (!selected) continue;
    if (!Number.isFinite(Date.parse(selected.expiresAt)) || Date.parse(selected.expiresAt) <= now)
      throw Error('所选地图候选已过期，请重新匹配，或改用自有地点坐标。');
    if (selected.provider !== provider) throw Error('起终点的地图服务范围不一致，请重新匹配，或改用自有地点坐标。');
    body[which + 'MatchToken'] = selected.token;
  }
  return body;
}
