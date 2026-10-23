/* 查询、匹配和缓存周边服务价格。 */

import { createHash } from "node:crypto";
import { searchAmapAround } from "../integrations/amap.mjs";
import { toGcj, mainlandEligible } from "../../public/coordinates.js";
import { matchServicePrice } from "../domain/service-pricing.mjs";

export function createServicePrices({ query, search = searchAmapAround }) {
  const flights = new Map();
  let retryAfter = 0;
  return async function price(place, context = {}) {
    const p = {
      ...place,
      country: place.country || place.location?.countryCode || context.country,
      mainlandCityVerified:
        place.mainlandCityVerified || context.mainlandCityVerified,
    };
    if (!mainlandEligible(p)) return { status: "unsupported", amount: null };
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          "amap-cost/2",
          p.name,
          p.lat,
          p.lng,
          p.classification.category,
        ]),
      )
      .digest("hex");
    const key = p.id + ":" + fingerprint;
    if (flights.has(key)) return flights.get(key);
    const work = (async () => {
      const cached = (
        await query(
          "SELECT payload FROM place_service_prices WHERE place_id=$1 AND fingerprint=$2 AND expires_at>now()",
          [p.id, fingerprint],
        )
      ).rows[0];
      if (cached) return { ...cached.payload, cached: true };
      if (Date.now() < retryAfter)
        return { status: "temporarily_unavailable", amount: null };
      let payload,
        ttl = 86400;
      try {
        const data = await search({
          keywords: p.name.slice(0, 80),
          location: toGcj(p),
          radius: 500,
          limit: 5,
          sort: "weight",
          details: true,
        });
        payload = matchServicePrice(p, data.pois);
      } catch (e) {
        payload = {
          status: "temporarily_unavailable",
          amount: null,
          provider: "amap",
          checkedAt: new Date().toISOString(),
        };
        ttl = 300;
        if ([429, 502, 503].includes(e.status))
          retryAfter = Date.now() + 300000;
      }
      await query(
        `INSERT INTO place_service_prices(place_id,fingerprint,payload,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 second')
        ON CONFLICT(place_id) DO UPDATE SET fingerprint=excluded.fingerprint,payload=excluded.payload,checked_at=now(),expires_at=excluded.expires_at`,
        [p.id, fingerprint, JSON.stringify(payload), ttl],
      );
      return payload;
    })().finally(() => flights.delete(key));
    flights.set(key, work);
    return work;
  };
}
