/* 根据位置和停留信息判断用户是否到访地点。 */

import { distance } from "../planner.mjs";

export function inferPresence(stops, samples, now = Date.now()) {
  if (samples.length < 6 || samples.length > 16) return [];
  if (
    samples.some(
      (s) =>
        ![s.lat, s.lng, s.accuracy, s.at].every(Number.isFinite) ||
        Math.abs(s.lat) > 90 ||
        Math.abs(s.lng) > 180 ||
        s.accuracy <= 0 ||
        s.accuracy > 60 ||
        s.at > now + 5000 ||
        s.at < now - 30 * 60_000,
    )
  )
    return [];
  if (
    now - samples.at(-1).at > 120_000 ||
    samples.at(-1).at - samples[0].at < 600_000
  )
    return [];
  for (let i = 1; i < samples.length; i++)
    if (
      samples[i].at - samples[i - 1].at < 20_000 ||
      samples[i].at - samples[i - 1].at > 120_000
    )
      return [];
  const matches = stops.filter((p) =>
    samples.every((s) => distance(p, s) * 1000 + s.accuracy <= 120),
  );
  if (matches.length !== 1) return [];
  return [
    {
      placeId: matches[0].id,
      source: "location_dwell",
      status: "inferred",
      observedAt: new Date(samples.at(-1).at).toISOString(),
      dwellSeconds: Math.floor((samples.at(-1).at - samples[0].at) / 1000),
    },
  ];
}
