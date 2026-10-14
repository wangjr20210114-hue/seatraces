import { z } from "zod";
import { randomUUID } from "node:crypto";
import { query as dbQuery, transaction as dbTransaction } from "../db.mjs";
import { catalogRequest } from "./catalog.mjs";
import {
  serviceSlots,
  rankServicePlaces,
  selectServiceBatch,
  serviceComparator,
  serviceSearchAnchors,
} from "../domain/trip-services.mjs";
const failure = (message, status = 400) =>
  Object.assign(Error(message), { status });
export const recommendationInput = z
  .object({
    day: z.number().int().min(0).max(29),
    radius: z.number().int().min(500).max(10000).optional(),
    groupMeals: z.boolean().optional(),
    activeSlot: z
      .string()
      .regex(/^(dining|lunch|dinner):\d{1,2}$|^stay:\d{1,2}-\d{1,2}$/)
      .optional(),
    sort: z.enum(["distance", "price", "comprehensive"]).optional(),
    refresh: z.boolean().optional(),
    excludePlaceIds: z.array(z.string().min(1).max(200)).max(200).optional(),
  })
  .strict();
export const selectionInput = z
  .object({
    version: z.number().int().positive(),
    recommendationId: z.uuid(),
    placeId: z.string().min(1).max(200),
  })
  .strict();
const removeInput = z.object({ version: z.number().int().positive() }).strict();
export function installTripServiceRoutes(
  app,
  {
    auth,
    query = dbQuery,
    transaction = dbTransaction,
    search = catalogRequest,
  },
) {
  const inflight = new Map();
  async function own(id, user, c = { query }, lock = false) {
    z.uuid().parse(id);
    const trip = (
      await c.query(
        "SELECT * FROM trips WHERE id=$1 AND user_id=$2" +
          (lock ? " FOR UPDATE" : ""),
        [id, user],
      )
    ).rows[0];
    if (!trip) throw failure("这份行程不存在", 404);
    if (trip.plan.schemaVersion !== "journey/2")
      throw failure("此旧版行程暂不支持吃住推荐", 409);
    return trip;
  }
  function findSlot(trip, id) {
    if (!/^(dining|lunch|dinner):\d{1,2}$|^stay:\d{1,2}-\d{1,2}$/.test(id))
      throw failure("吃住位置无效");
    const day = Number(id.split(":")[1].split("-")[0]);
    const slot = serviceSlots(trip.plan, day, {
      groupMeals: id.startsWith("dining:"),
    }).find((s) => s.id === id);
    if (!slot) throw failure("行程已变化，请重新打开吃住推荐", 409);
    return slot;
  }
  const summary = (trip) => ({
    tripId: trip.id,
    version: trip.version,
    days: trip.plan.days.map((day, index) => ({
      day: index,
      date: day.date,
      city: day.city,
      slots: serviceSlots(trip.plan, index),
    })),
  });
  app.get("/api/journey/trips/:id/services", auth, async (req, res) =>
    res.json(summary(await own(req.params.id, req.user.id))),
  );
  async function recommend(trip, slot, radius) {
    const key = [trip.id, slot.id, slot.scopeKey, radius].join("|");
    if (inflight.has(key)) return inflight.get(key);
    const work = (async () => {
      const cached = (
        await query(
          "SELECT * FROM trip_service_recommendations WHERE trip_id=$1 AND slot_id=$2 AND scope_key=$3 AND radius=$4 AND expires_at>now()",
          [trip.id, slot.id, slot.scopeKey, radius],
        )
      ).rows[0];
      if (cached?.payload.poolVersion === 2)
        return { ...cached.payload, recommendationId: cached.id, cached: true };
      try {
        const responses = [];
        for (const anchor of serviceSearchAnchors({ ...slot, radius })) {
          responses.push(
            await search("/places", {
              q: "",
              category: slot.kind === "stay" ? "accommodation" : "food",
              lat: anchor.lat,
              lng: anchor.lng,
              radius,
              limit: 40,
            }),
          );
        }
        const valid = responses.filter((d) =>
          ["live", "snapshot"].includes(d.status),
        );
        const data = {
          status: valid.length
            ? valid.some((d) => d.status === "snapshot")
              ? "snapshot"
              : "live"
            : "unavailable",
          items: valid.flatMap((d) => d.items || []),
          cachedAt: valid.find((d) => d.cachedAt)?.cachedAt,
        };
        if (!["live", "snapshot"].includes(data.status))
          throw failure("地点服务暂不可用", 503);
        const payload = {
          poolVersion: 2,
          status: data.status,
          items: rankServicePlaces(data.items || [], data, slot),
          queriedAt: new Date().toISOString(),
          sourceCachedAt: data.cachedAt || null,
          radius,
          cached: false,
        };
        const id = randomUUID();
        await query(
          `INSERT INTO trip_service_recommendations(id,trip_id,slot_id,scope_key,radius,payload) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(trip_id,slot_id,scope_key,radius) DO UPDATE SET id=excluded.id,payload=excluded.payload,created_at=now(),expires_at=now()+interval '6 hours'`,
          [
            id,
            trip.id,
            slot.id,
            slot.scopeKey,
            radius,
            JSON.stringify(payload),
          ],
        );
        // Old scopes never grow indefinitely; saved selections live in trip versions.
        await query(
          "DELETE FROM trip_service_recommendations WHERE trip_id=$1 AND expires_at<now()",
          [trip.id],
        );
        return { ...payload, recommendationId: id };
      } catch (e) {
        return {
          status: "unavailable",
          items: [],
          radius,
          code: e.code || "recommendations_unavailable",
          message: "附近资料暂时没加载出来，稍后重试。",
        };
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, work);
    return work;
  }
  app.post(
    "/api/journey/trips/:id/services/recommendations",
    auth,
    async (req, res) => {
      const body = recommendationInput.parse(req.body),
        trip = await own(req.params.id, req.user.id),
        slots = [];
      // The read gateway permits two queries. Sequential reads avoid a burst per user.
      for (const slot of serviceSlots(trip.plan, body.day, {
        groupMeals: body.groupMeals,
      })) {
        const pool = await recommend(trip, slot, body.radius || slot.radius);
        const active = !body.activeSlot
          ? slot.kind === "dining"
          : slot.id === body.activeSlot;
        const batch = body.groupMeals
          ? selectServiceBatch(pool.items, {
              ...body,
              sort: "distance",
              kind: slot.kind,
              radius: pool.radius,
              refresh: active && body.refresh,
              excludePlaceIds: active ? body.excludePlaceIds : [],
            })
          : {
              items: [...pool.items]
                .sort(serviceComparator("distance"))
                .slice(0, 5),
            };
        slots.push({
          ...slot,
          ...pool,
          ...batch,
          sort: "distance",
        });
      }
      res.json({
        tripId: trip.id,
        version: trip.version,
        day: body.day,
        slots,
        automaticSelection: false,
      });
    },
  );
  async function validated(trip, slot, body, c = { query }) {
    if (trip.version !== body.version)
      throw failure("行程已更新，请重新打开后选择", 409);
    const pool = (
      await c.query(
        "SELECT * FROM trip_service_recommendations WHERE id=$1 AND trip_id=$2 AND slot_id=$3 AND scope_key=$4 AND expires_at>now()",
        [body.recommendationId, trip.id, slot.id, slot.scopeKey],
      )
    ).rows[0];
    const candidate = pool?.payload.items.find((p) => p.id === body.placeId);
    if (!candidate)
      throw failure("推荐已过期或地点不在当前候选中，请重新加载", 409);
    return candidate;
  }
  app.post(
    "/api/journey/trips/:id/services/:slot/preview",
    auth,
    async (req, res) => {
      const body = selectionInput.parse(req.body),
        trip = await own(req.params.id, req.user.id),
        slot = findSlot(trip, req.params.slot);
      res.json({
        tripId: trip.id,
        version: trip.version,
        slot,
        candidate: await validated(trip, slot, body),
        effect: {
          type: "nearby_choice",
          affectedDays: slot.days,
          scenicOrderChanged: false,
          reservationMade: false,
        },
      });
    },
  );
  async function save(req, res, remove = false) {
    const body = (remove ? removeInput : selectionInput).parse(req.body);
    const trip = await transaction(async (c) => {
      const current = await own(req.params.id, req.user.id, c, true),
        slot = findSlot(current, req.params.slot);
      if (current.version !== body.version)
        throw failure("行程已更新，请重新打开后选择", 409);
      const services = { ...(current.plan.services || {}) };
      if (remove) delete services[slot.id];
      else
        services[slot.id] = {
          slotId: slot.id,
          kind: slot.kind,
          days: slot.days,
          scopeKey: slot.scopeKey,
          selectedAt: new Date().toISOString(),
          candidate: await validated(current, slot, body, c),
        };
      const plan = { ...current.plan, services };
      await c.query(
        "INSERT INTO trip_versions(trip_id,version,plan,reason) VALUES($1,$2,$3,$4)",
        [
          current.id,
          current.version + 1,
          JSON.stringify(plan),
          (remove ? "移除" : "选择") + slot.title,
        ],
      );
      return (
        await c.query(
          "UPDATE trips SET plan=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *",
          [JSON.stringify(plan), current.id],
        )
      ).rows[0];
    });
    res.json({ trip, services: summary(trip) });
  }
  app.put("/api/journey/trips/:id/services/:slot", auth, (req, res) =>
    save(req, res),
  );
  app.delete("/api/journey/trips/:id/services/:slot", auth, (req, res) =>
    save(req, res, true),
  );
}
