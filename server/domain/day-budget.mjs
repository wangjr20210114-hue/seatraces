import { distance } from "../planner.mjs";

// Planning coefficients, not a model fitted to observed journeys. Amap replaces
// the travel estimate later; visit durations remain explicit planning allowances.
export function dayBudget(pace = "balanced", transfer = false) {
  const rule = {
    relaxed: { end: 17 * 60, buffer: 12 },
    balanced: { end: 18 * 60, buffer: 8 },
    full: { end: 19 * 60, buffer: 5 },
  }[pace] || { end: 18 * 60, buffer: 8 };
  const start = transfer ? 14 * 60 : 9 * 60;
  return {
    ruleVersion: "time-budget/1",
    start,
    end: rule.end,
    availableMinutes: rule.end - start,
    transitionMinutes: rule.buffer,
    mealMinutes: transfer ? 0 : 45,
    travelSource: "distance_estimate",
  };
}

export function visitAllowance(place, now = Date.now()) {
  const fact = place.facts?.stayMinutes;
  const sourced = Number(fact?.value);
  if (
    Number.isFinite(sourced) &&
    sourced > 0 &&
    sourced <= 1440 &&
    fact.status !== "expired" &&
    fact.sourceUrl &&
    (!fact.expiresAt || Date.parse(fact.expiresAt) > now)
  )
    return { minutes: Math.ceil(sourced), source: "sourced" };
  const t = place.traits || {};
  const minutes =
    { museum: 120, zoo: 180, theme_park: 240, viewpoint: 25, artwork: 20 }[
      t.tourism
    ] ||
    { memorial: 20, monument: 30, wayside_shrine: 15, archaeological_site: 90 }[
      t.historic
    ] ||
    (t.leisure === "park" ? 60 : 90);
  return { minutes, source: "planning_allowance" };
}

export function travelAllowance(from, to, transport = "balanced") {
  if (!from) return 0;
  const km = distance(from, to);
  // Approximate road detour / speed / boarding time. Never used for navigation.
  if (km <= 1.2 && transport !== "fewWalking")
    return Math.max(3, Math.ceil(((km * 1.3) / 4) * 60));
  return Math.ceil(12 + ((km * 1.3) / 18) * 60);
}

export function breakBeforeStop(stops, clock, budget) {
  if (!stops.length) return { minutes: 0, meal: false };
  const meal =
    budget.mealMinutes > 0 &&
    clock >= 12 * 60 &&
    !stops.some((s) => s.mealBefore);
  return {
    minutes: budget.transitionMinutes + (meal ? budget.mealMinutes : 0),
    meal,
  };
}

export const clockTime = (n) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
