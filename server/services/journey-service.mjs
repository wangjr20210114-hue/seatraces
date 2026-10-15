import { z } from "zod";
import { randomUUID } from "node:crypto";
import { query, transaction } from "../db.mjs";
import { clusterCity } from "./city-clusters.mjs";
import {
  cityBoundaries,
  publicBoundary,
  districtOf,
} from "./city-boundaries.mjs";
import { createReadJobs } from "./read-jobs.mjs";
const cityReadJob = createReadJobs();
import { catalogRequest } from "./catalog.mjs";
import { personalizedQuestions } from "./questions.mjs";
import {
  allocateDates,
  draftJourney,
  journeyAnswers,
} from "./journey-draft.mjs";
import { route } from "./routes.mjs";
import { matchPlace } from "./place-matching.mjs";
import { distance } from "../planner.mjs";
import { openingOnDate } from "../opening-hours.mjs";
import { applyWishes, representedIds } from "../domain/scenic-entities.mjs";
import { inferPresence } from "../domain/place-presence.mjs";
import { breakBeforeStop } from "../domain/day-budget.mjs";
const error = (message, status = 400) =>
  Object.assign(Error(message), { status });
export const journeyRequest = z
  .object({
    origin: z
      .object({
        label: z.string().trim().min(1).max(150),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
      })
      .strict(),
    cityIds: z.array(z.string().min(1).max(80)).min(1).max(5),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
export function mergeVisits(completed, declared, inferred = []) {
  const result = {};
  for (const p of inferred)
    result[p.place_id] = {
      source: "location_dwell",
      status: "inferred",
      date: p.observed_at,
      dwellSeconds: p.dwell_seconds,
    };
  for (const row of completed)
    for (const day of row.plan.days || [])
      for (const p of day.stops || [])
        result[p.id] = { source: "completed_trip", date: day.date };
  for (const p of declared) {
    if (p.visited)
      result[p.place_id] = { source: "user_confirmed", date: p.visited_at };
    else delete result[p.place_id];
  }
  return result;
}
async function visitsFor(user) {
  const [completed, declared, inferred] = await Promise.all([
    query("SELECT plan FROM trips WHERE user_id=$1 AND status='completed'", [
      user,
    ]),
    query("SELECT * FROM user_place_visits WHERE user_id=$1", [user]),
    query("SELECT * FROM user_place_presence WHERE user_id=$1", [user]),
  ]);
  return mergeVisits(completed.rows, declared.rows, inferred.rows);
}
async function wishesFor(user) {
  const r = await query(
    "SELECT place_id,wanted FROM user_place_wishes WHERE user_id=$1",
    [user],
  );
  return Object.fromEntries(r.rows.map((p) => [p.place_id, p.wanted]));
}
export async function citySelectionForUser(city, user, travelHabit) {
  const [habit, visits, wishes] = await Promise.all([travelHabit(user), visitsFor(user.id), wishesFor(user.id)]);
  const result = await clusterCity(city, habit, visits, {}, wishes);
  const signals = await signalsFor(result.clusters.flatMap(c => c.members.flatMap(representedIds)));
  if (Object.keys(signals).length) result.clusters = (await clusterCity(city, habit, visits, signals, wishes)).clusters;
  return result;
}
async function signalsFor(ids) {
  const result = {};
  for (const s of (
    await query(
      "SELECT * FROM place_signals WHERE place_id=ANY($1) AND observed_at<=now() AND expires_at>now()",
      [ids],
    )
  ).rows) {
    (result[s.place_id] ||= {})[s.kind] = {
      value: s.value,
      sourceUrl: s.source_url,
      observedAt: s.observed_at,
      expiresAt: s.expires_at,
    };
  }
  return result;
}
async function ownSession(id, user) {
  z.uuid().parse(id);
  const s = (
    await query("SELECT * FROM journey_sessions WHERE id=$1 AND user_id=$2", [
      id,
      user,
    ])
  ).rows[0];
  if (!s) throw error("问卷不存在", 404);
  return s;
}
async function ownTrip(id, user) {
  z.uuid().parse(id);
  const t = (
    await query("SELECT * FROM trips WHERE id=$1 AND user_id=$2", [id, user])
  ).rows[0];
  if (!t) throw error("行程不存在", 404);
  if (t.plan.schemaVersion !== "journey/2")
    throw error("请从原版行程页查看这份行程", 409);
  return t;
}
export function selectedPools(catalog, selections, cities, wishes) {
  const pools = {};
  for (const city of cities) {
    const all = catalog[city.id]?.clusters;
    if (!all) throw error("请先选择每座城市的片区");
    const ids = selections[city.id];
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 30 ||
      new Set(ids).size !== ids.length
    )
      throw error("每座城市请选择 1～30 个片区");
    const groups = ids.map((id) => all.find((c) => c.id === id));
    if (groups.some((c) => !c)) throw error("景点片区已经变化，请重新选择");
    const points = [],
      seen = new Set();
    const decorate = (p, g) => ({
      ...(wishes ? applyWishes(p, wishes) : p),
      clusterId: g.id,
    });
    for (const g of groups)
      for (const raw of g.members) {
        const p = decorate(raw, g);
        if (p.wanted && !seen.has(p.id)) {
          points.push(p);
          seen.add(p.id);
        }
      }
    // All wishes survive the planning shortlist; regular candidates stay bounded.
    const limit = points.length + 60;
    const longest = Math.max(...groups.map((g) => g.members.length));
    for (let i = 0; i < longest && points.length < limit; i++)
      for (const g of groups) {
        const p = g.members[i];
        if (p && !seen.has(p.id) && points.length < limit) {
          points.push(decorate(p, g));
          seen.add(p.id);
        }
      }
    pools[city.id] = points;
  }
  return pools;
}
export function enrichCandidate(p, detail, visits, signals) {
  const visit = [p.id, ...(p.possibleDuplicateIds || [])]
    .map((id) => visits[id])
    .find(Boolean);
  return {
    ...p,
    ...detail,
    aliases: [...new Set([...(p.aliases || []), ...(detail.aliases || [])])],
    possibleDuplicateIds: p.possibleDuplicateIds || [],
    children: p.children || [],
    sourceRecords: p.sourceRecords || [],
    sourceRecordCount: p.sourceRecordCount,
    wanted: Boolean(p.wanted),
    ownWanted: Boolean(p.ownWanted),
    city: p.city,
    country: p.country,
    mainlandCityVerified: p.mainlandCityVerified,
    timezone: p.timezone,
    traits: p.traits,
    clusterId: p.clusterId,
    visited: Boolean(visit),
    visitHistory: visit || null,
    signals: signals[p.id] || {},
  };
}
const pending = new Map(),
  routeCache = new Map();
async function singleFlight(key, fn) {
  if (pending.has(key)) return pending.get(key);
  const work = fn().finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}
export function installJourneyRoutes(app, { auth, travelHabit }) {
  // Preview boundaries before the date/session step, using the same shared cache.
  app.get("/api/journey/cities/:cityId/boundary", auth, async (req, res) => {
    const id = z.string().min(1).max(80).parse(req.params.cityId);
    const city = (await query("SELECT id,name,country,province,lat,lng,timezone FROM places WHERE category='city' AND id=$1", [id])).rows[0];
    if (!city) throw error("城市不存在", 404);
    res.json({ city, boundary: publicBoundary(await cityBoundaries(city)) });
  });
  app.post("/api/journey/sessions", auth, async (req, res) => {
    const input = journeyRequest.parse(req.body);
    if (new Set(input.cityIds).size !== input.cityIds.length)
      throw error("城市不能重复");
    const cities = (
      await query(
        "SELECT id,name,country,province,lat,lng,timezone FROM places WHERE category='city' AND id=ANY($1)",
        [input.cityIds],
      )
    ).rows.sort(
      (a, b) => input.cityIds.indexOf(a.id) - input.cityIds.indexOf(b.id),
    );
    if (cities.length !== input.cityIds.length) throw error("请从列表选择城市");
    if (
      new Set(cities.map((c) => c.country + ":" + c.name.replace(/市$/, "")))
        .size !== cities.length
    )
      throw error("同一座城市只选一次就好");
    allocateDates(input, cities);
    const id = randomUUID();
    await query(
      "INSERT INTO journey_sessions(id,user_id,request) VALUES($1,$2,$3)",
      [id, req.user.id, JSON.stringify({ ...input, cities })],
    );
    res.status(201).json({ id, cities });
  });
  app.post(
    "/api/journey/sessions/:id/cities/:cityId",
    auth,
    async (req, res) => {
      const s = await ownSession(req.params.id, req.user.id),
        city = s.request.cities.find((c) => c.id === req.params.cityId);
      if (!city) throw error("城市不在本次旅行中");
      const key = `city:${req.user.id}:${s.id}:${city.id}`;
      const work = () =>
        singleFlight(key, async () => {
          const result = await citySelectionForUser(city, req.user, travelHabit);
          // Save selected candidates and the separate parent overlay. Raw provider
          // responses and administrative boundary geometry are not stored here.
          await query(
            "UPDATE journey_sessions SET catalog=jsonb_set(catalog,ARRAY[$3],$4::jsonb),updated_at=now() WHERE id=$1 AND user_id=$2",
            [
              s.id,
              req.user.id,
              city.id,
              JSON.stringify({
                clusters: result.clusters,
                coverage: result.coverage,
                inventory: result.inventory,
                parentLookup: result.parentLookup,
              }),
            ],
          );
          return result;
        });
      const result =
        req.query.async === "1" ? cityReadJob(key, work) : await work();
      res.status(result.status === "loading" ? 202 : 200).json(result);
    },
  );
  app.get(
    "/api/journey/sessions/:id/cities/:cityId/boundary",
    auth,
    async (req, res) => {
      const session = await ownSession(req.params.id, req.user.id);
      const city = session.request.cities.find(
        (c) => c.id === req.params.cityId,
      );
      if (!city) throw error("城市不在本次旅行中");
      const boundary = await cityBoundaries(city);
      res.json({
        boundary: publicBoundary(boundary),
        districts: Object.fromEntries(
          (session.catalog[city.id]?.clusters || []).map((g) => [
            g.id,
            [
              ...new Set(
                g.members.map((p) => districtOf(p, boundary)).filter(Boolean),
              ),
            ],
          ]),
        ),
      });
    },
  );
  app.post("/api/journey/sessions/:id/visits", auth, async (req, res) => {
    const s = await ownSession(req.params.id, req.user.id),
      b = z
        .object({ placeId: z.string().max(80), visited: z.boolean() })
        .strict()
        .parse(req.body);
    if (
      !Object.values(s.catalog).some((c) =>
        c.clusters.some((g) => g.members.some((p) => p.id === b.placeId)),
      )
    )
      throw error("地点不在候选范围内");
    await query(
      "INSERT INTO user_place_visits(user_id,place_id,visited) VALUES($1,$2,$3) ON CONFLICT(user_id,place_id) DO UPDATE SET visited=excluded.visited,updated_at=now()",
      [req.user.id, b.placeId, b.visited],
    );
    res.json({ ok: true });
  });
  app.post("/api/journey/sessions/:id/wishes", auth, async (req, res) => {
    const s = await ownSession(req.params.id, req.user.id);
    const b = z
      .object({ placeId: z.string().min(1).max(80), wanted: z.boolean() })
      .strict()
      .parse(req.body);
    const places = Object.values(s.catalog).flatMap((c) =>
      c.clusters.flatMap((g) =>
        g.members.flatMap((p) => [p, ...(p.children || [])]),
      ),
    );
    const p = places.find((p) => p.id === b.placeId);
    if (!p) throw error("地点不在候选范围内");
    await transaction(async (db) => {
      for (const id of [p.id, ...(p.possibleDuplicateIds || [])])
        await db.query(
          "INSERT INTO user_place_wishes(user_id,place_id,wanted) VALUES($1,$2,$3) ON CONFLICT(user_id,place_id) DO UPDATE SET wanted=excluded.wanted,updated_at=now()",
          [req.user.id, id, b.wanted],
        );
    });
    res.json({ placeId: p.id, wanted: b.wanted });
  });
  app.post("/api/journey/sessions/:id/questions", auth, async (req, res) => {
    const s = await ownSession(req.params.id, req.user.id);
    const result = await singleFlight("questions:" + s.id, async () => {
      if (s.questions) return s.questions;
      const habit = await travelHabit(req.user),
        r = await personalizedQuestions(habit);
      r.questions.push(
        {
          id: "crowd",
          title: "热闹一点，还是清静一点？",
          type: "single",
          options: [
            { value: "avoid", label: "想躲开人群" },
            { value: "balanced", label: "都可以" },
            { value: "lively", label: "热闹也不错" },
          ],
        },
        {
          id: "revisit",
          title: "去过的地方，还想再逛吗？",
          type: "single",
          options: [
            { value: "new", label: "这次探索新地方" },
            { value: "either", label: "喜欢的地方值得重游" },
          ],
        },
      );
      r.defaults = journeyAnswers.parse({
        interests: habit.interests || [],
        pace: habit.pace || "balanced",
        transport: habit.transport || "balanced",
        crowd: habit.crowd || "balanced",
        revisit: habit.revisit || "new",
      });
      await query(
        "UPDATE journey_sessions SET questions=$2,updated_at=now() WHERE id=$1",
        [s.id, JSON.stringify(r)],
      );
      return r;
    });
    res.json(result);
  });
  app.post("/api/journey/sessions/:id/generate", auth, async (req, res) => {
    const s = await ownSession(req.params.id, req.user.id),
      b = z
        .object({
          selections: z.record(z.string(), z.array(z.string()).max(30)),
          answers: journeyAnswers,
        })
        .strict()
        .parse(req.body);
    const result = await singleFlight("generate:" + s.id, async () => {
      const current = await ownSession(s.id, req.user.id);
      if (current.trip_id) return ownTrip(current.trip_id, req.user.id);
      const pools = selectedPools(
          current.catalog,
          b.selections,
          current.request.cities,
          await wishesFor(req.user.id),
        ),
        all = Object.values(pools).flat(),
        [visits, signals] = await Promise.all([
          visitsFor(req.user.id),
          signalsFor(all.map((p) => p.id)),
        ]);
      const enriched = new Map();
      const osmPlaces = all.filter((p) => p.id.startsWith("osm:"));
      for (let i = 0; i < osmPlaces.length; i += 30) {
        const r = await catalogRequest("/place-batch", {
          ids: osmPlaces
            .slice(i, i + 30)
            .map((p) => p.id)
            .join(","),
        });
        if (!["live", "snapshot"].includes(r.status))
          throw error("地点资料暂不可用", 503);
        for (const p of r.items) enriched.set(p.id, p);
      }
      for (const id of Object.keys(pools))
        pools[id] = pools[id].map((p) =>
          enrichCandidate(p, enriched.get(p.id) || {}, visits, signals),
        );
      const plan = await draftJourney(
          current.request,
          current.request.cities,
          pools,
          b.answers,
        ),
        id = randomUUID(),
        title =
          current.request.cities.map((c) => c.name).join(" · ") +
          ` ${plan.days.length} 日漫游`,
        request = {
          ...current.request,
          ...b.answers,
          selections: b.selections,
        };
      await transaction(async (c) => {
        await c.query(
          "INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,$3,$4,$5)",
          [
            id,
            req.user.id,
            title,
            JSON.stringify(request),
            JSON.stringify(plan),
          ],
        );
        await c.query(
          "INSERT INTO trip_versions(trip_id,version,plan,reason) VALUES($1,1,$2,'景点聚类问卷生成')",
          [id, JSON.stringify(plan)],
        );
        await c.query(
          "UPDATE journey_sessions SET trip_id=$2,updated_at=now() WHERE id=$1",
          [s.id, id],
        );
      });
      return ownTrip(id, req.user.id);
    });
    res.json(result);
  });
  app.post("/api/journey/trips/:id/presence", auth, async (req, res) => {
    const trip = await ownTrip(req.params.id, req.user.id);
    const b = z
      .object({
        samples: z
          .array(
            z
              .object({
                lat: z.number().min(-90).max(90),
                lng: z.number().min(-180).max(180),
                accuracy: z.number().positive().max(10000),
                at: z.number().finite(),
              })
              .strict(),
          )
          .min(6)
          .max(16),
      })
      .strict()
      .parse(req.body);
    const today = (timezone) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone || "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    const stops = trip.plan.days
      .filter((d) => d.date === today(d.timezone))
      .flatMap((d) => d.stops);
    const observations = inferPresence(stops, b.samples);
    for (const p of observations)
      await query(
        "INSERT INTO user_place_presence(user_id,place_id,observed_at,dwell_seconds) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,place_id) DO UPDATE SET observed_at=excluded.observed_at,dwell_seconds=excluded.dwell_seconds",
        [req.user.id, p.placeId, p.observedAt, p.dwellSeconds],
      );
    res.json({ observations });
  });
  app.post("/api/journey/trips/:id/days/:day/route", auth, async (req, res) => {
    const trip = await ownTrip(req.params.id, req.user.id),
      index = z.coerce.number().int().min(0).max(29).parse(req.params.day),
      day = trip.plan.days[index];
    if (!day) throw error("旅行日期不存在");
    const key = trip.id + ":" + trip.version + ":" + index;
    const result = await singleFlight("route:" + key, async () => {
      const cached = routeCache.get(key);
      if (cached?.expires > Date.now()) return cached.value;
      const refs = {},
        legs = [],
        warnings = [];
      if (day.stops.length > 1)
        for (const p of day.stops) {
          const matched = await matchPlace(p),
            best = matched.items?.find(
              (c) =>
                c.nameScore >= 0.75 && c.distanceMeters <= 1000 && c.routing,
            );
          if (best) refs[p.id] = best.routing;
          else warnings.push(`${p.name}的出入口待确认`);
        }
      for (let i = 1; i < day.stops.length; i++) {
        const a = day.stops[i - 1],
          b = day.stops[i],
          mode = distance(a, b) <= 1.2 ? "walking" : "transit";
        if (!refs[a.id] || !refs[b.id]) {
          legs.push({
            from: a.id,
            to: b.id,
            status: "unresolved",
            segments: [],
          });
          continue;
        }
        const r = await route(
          a,
          b,
          trip.request.transport,
          mode,
          day.date + "T" + a.leave,
          day.timezone,
          { from: refs[a.id], to: refs[b.id] },
        );
        const chosen = r.status === "live" ? r.alternatives?.[0] : null;
        legs.push({
          from: a.id,
          to: b.id,
          status: chosen ? "live" : r.status,
          provider: r.provider,
          minutes: chosen?.minutes || null,
          segments: chosen?.segments || [],
        });
      }
      const timing = await routeTiming(day, legs);
      warnings.push(...timing.warnings);
      const value = {
        day: index,
        legs,
        timing: timing.stops,
        warnings,
        status: legs.every((l) => l.status === "live") ? "live" : "partial",
        checkedAt: new Date().toISOString(),
      };
      routeCache.set(key, { expires: Date.now() + 15 * 60_000, value });
      if (routeCache.size > 60)
        routeCache.delete(routeCache.keys().next().value);
      return value;
    });
    res.json(result);
  });
}
export async function routeTiming(day, legs, opening = openingOnDate) {
  const warnings = [],
    stops = [];
  const budget = day.timeBudget || {
    start: day.transferAllowance ? 840 : 540,
    end: 1140,
    transitionMinutes: 30,
    mealMinutes: 0,
  };
  let clock = budget.start;
  const min = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)),
    time = (n) =>
      `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  for (let i = 0; i < day.stops.length; i++) {
    const p = day.stops[i],
      leg = legs[i - 1];
    if (
      i &&
      (leg?.status !== "live" ||
        !Number.isFinite(leg.minutes) ||
        leg.minutes < 0)
    )
      return {
        stops: [],
        warnings: ["部分路段还没有可用路线，时间保留为草稿"],
      };
    const pause = breakBeforeStop(stops, clock, budget);
    clock += pause.minutes;
    if (i) clock += Math.ceil(leg.minutes);
    let hours = null;
    try {
      hours = await opening(p, day.date);
    } catch {}
    if (hours?.status === "parsed") {
      if (hours.dayState === "closed") warnings.push(p.name + "当日闭馆");
      const fitting = hours.intervals?.find(
        (w) =>
          !w.unknown &&
          Math.max(clock, min(w.start)) + p.duration_min <= min(w.end),
      );
      if (fitting) clock = Math.max(clock, min(fitting.start));
      else if (hours.intervals?.length)
        warnings.push(p.name + "可能赶不上开放时间");
    }
    if (clock + p.duration_min > budget.end)
      warnings.push("这一天有点满，可以少选一处");
    stops.push({
      id: p.id,
      arrive: time(clock),
      leave: time(clock + p.duration_min),
      status: "route_estimate",
      breakBeforeMinutes: pause.minutes,
      mealBefore: pause.meal,
    });
    clock += p.duration_min;
  }
  return { stops, warnings: [...new Set(warnings)] };
}
