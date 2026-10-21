import { scorePlace } from '../domain/scenic-clusters.mjs';
import { allowedByCurrentTrip } from '../domain/travel-constraints.mjs';

// Keep only planning evidence in the conversation, not whole provider responses.
export function areaSummary(groups) {
  const traits = ['tourism','historic','leisure','natural','wikipedia','wikidata','heritage','website'];
  const place = p => ({
    id: p.id, name: p.name, aliases: p.aliases, lat: p.lat, lng: p.lng,
    category: p.category, hierarchyOnly: p.hierarchyOnly,
    traits: Array.isArray(p.traits) ? p.traits : Object.fromEntries(traits.filter(k => p.traits?.[k] !== undefined).map(k => [k, p.traits[k]])), wanted: p.wanted, visited: p.visited,
    visitHistory: p.visitHistory ? {source:p.visitHistory.source} : undefined, signals: p.signals, opening_hours: p.opening_hours,
    score: p.score, children: (p.children || []).map(place),
  });
  return groups.map(g => ({ id: g.id, name: g.name, members: g.members.map(place) }));
}

export function eligiblePlace(p, preferences) {
  return allowedByCurrentTrip(p, preferences) &&
    (p.wanted || preferences.revisit !== 'new' || !p.visited || p.visitHistory?.source === 'location_dwell');
}

export function preferenceScore(p, preferences) {
  const score = scorePlace(p, preferences, p.signals || {});
  // The catalog already includes the account's behavioral interest weights.
  // Explicit interests for this trip take priority over that weak signal.
  return score.total + (preferences.interests?.length ? 0 : Number(p.score?.parts?.inferredPreference || 0));
}

export function selectTravelAreas(groups, preferences, days = 1) {
  const ranked = groups.map(g => {
    const members = g.members.filter(p => eligiblePlace(p, preferences));
    const scores = members.map(p => preferenceScore(p, preferences) +
      .25 * Math.max(0, ...(p.children || []).filter(c => eligiblePlace(c, preferences)).map(c => preferenceScore(c, preferences))))
      .sort((a, b) => b - a).slice(0, 5);
    return { ...g, members, wanted: members.some(p => p.wanted),
      score: scores.reduce((n, s) => n + s, 0) / (scores.length || 1) };
  }).filter(g => g.members.length)
    .sort((a, b) => Number(b.wanted) - Number(a.wanted) || b.score - a.score || a.id.localeCompare(b.id));
  const selected = [], seen = new Set();
  const target = Math.max(2, days * ({ relaxed: 3, balanced: 5, full: 7 }[preferences.pace] || 5));
  for (const g of ranked) {
    if (!g.wanted && seen.size >= target) continue;
    selected.push(g);
    for (const p of g.members) seen.add(p.id || p.name);
  }
  return selected.slice(0, 30);
}
