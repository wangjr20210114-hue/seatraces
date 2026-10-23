/* 管理交通路线候选项及已选路线状态。 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mainlandEligible, toGcj } from '../public/coordinates.js';

const invalid = () => Object.assign(Error('地点候选选择已失效或不属于当前地点，请重新匹配并选择。'), { status: 409 });
const idOK = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f]/u.test(value);
const locationOK = value => {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,6})?,-?\d+(?:\.\d{1,6})?$/.test(value)) return false;
  const [lng, lat] = value.split(',').map(Number);
  return Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
};
const referenceOK = ref => ref && ['amap', 'google'].includes(ref.provider) && idOK(ref.id) &&
  (ref.provider === 'amap' ? locationOK(ref.location) : ref.location === undefined);

export function createRouteSelection({ now = Date.now, ttlMs = 15 * 60_000 } = {}) {
  const secret = randomBytes(32);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60_000) throw Error('Invalid candidate lifetime');
  const sign = text => createHmac('sha256', secret).update(text).digest();
  return {
    issue(userId, placeId, reference) {
      if (!idOK(String(userId)) || !idOK(placeId) || !referenceOK(reference)) throw invalid();
      const expiresAt = now() + ttlMs;
      const ref = { provider: reference.provider, id: reference.id,
        ...(reference.provider === 'amap' ? { location: reference.location } : {}) };
      const payload = Buffer.from(JSON.stringify({ v: 1, user: String(userId), place: placeId, expiresAt, ref })).toString('base64url');
      return { routeToken: payload + '.' + sign(payload).toString('base64url'), expiresAt: new Date(expiresAt).toISOString() };
    },
    resolve(token, userId, placeId, provider) {
      if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
      const [payload, signature] = token.split('.'), supplied = Buffer.from(signature, 'base64url');
      if (supplied.length !== 32 || !timingSafeEqual(supplied, sign(payload))) throw invalid();
      let data;
      try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw invalid(); }
      if (data.v !== 1 || data.user !== String(userId) || data.place !== placeId ||
        !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= now() || data.expiresAt > now() + ttlMs ||
        !referenceOK(data.ref) || data.ref.provider !== provider) throw invalid();
      return data.ref;
    }
  };
}

export const routingProvider = (a, b) => mainlandEligible(a) && mainlandEligible(b) ? 'amap' : 'google';

export function amapEndpointParams(a, b, mode, selections = {}) {
  for (const ref of [selections.from, selections.to]) if (ref && (!referenceOK(ref) || ref.provider !== 'amap')) throw invalid();
  const params = { origin: selections.from?.location || toGcj(a), destination: selections.to?.location || toGcj(b) };
  if (['walking', 'driving'].includes(mode)) {
    if (selections.from) params.origin_id = selections.from.id;
    if (selections.to) params.destination_id = selections.to.id;
  } else if (mode === 'transit' && selections.from && selections.to) {
    params.originpoi = selections.from.id;
    params.destinationpoi = selections.to.id;
  }
  return params;
}
