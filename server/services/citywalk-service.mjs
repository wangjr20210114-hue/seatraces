/* 提供 CityWalk 的规划、编辑、保存和读取接口。 */

import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { query as dbQuery, transaction as dbTransaction } from "../db.mjs";
import { cityWalkCatalog, nearbyWalkPlaces } from "./citywalk-catalog.mjs";
import { uniqueWalkPlaces } from "../domain/walk-clusters.mjs";
import { walkingRouter } from "./citywalk-routing.mjs";
import { createReadJobs } from "./read-jobs.mjs";
import { orderWalk, walkName } from "../../public/citywalk-route.js";

const error = (message, status = 400) =>
  Object.assign(Error(message), { status });
const inputSchema = z
  .object({
    id: z.uuid(),
    draftId: z.uuid(),
    title: z.string().trim().min(1).max(80),
    clusterIds: z.array(z.string().min(1).max(200)).min(1).max(50),
    stopIds: z.array(z.string().min(1).max(200)).min(2).max(100),
    startId: z.string().min(1).max(200),
    version: z.number().int().min(1).optional(),
  })
  .strict();
export function selectedWalk(draft, input, previous) {
  if (
    new Set(input.stopIds).size !== input.stopIds.length ||
    new Set(input.clusterIds).size !== input.clusterIds.length
  )
    throw error("景点或片区不能重复");
  const groups = input.clusterIds.map((id) =>
    draft.catalog.clusters.find((g) => g.id === id),
  );
  if (groups.some((g) => !g)) throw error("片区已变化，请重新选择");
  const candidates = new Map(
    groups.flatMap((g) => g.members).map((p) => [p.id, p]),
  );
  if (previous?.city.id === draft.city.id)
    for (const p of previous.stops)
      if (!candidates.has(p.id)) candidates.set(p.id, p);
  const stops = input.stopIds.map((id) => candidates.get(id));
  if (stops.some((p) => !p) || !input.stopIds.includes(input.startId))
    throw error("请选择当前片区中的景点");
  return orderWalk(stops, input.startId).map((p) => ({
    id: p.id,
    name: walkName(p),
    aliases: [...new Set([p.name, ...(p.aliases || [])])].filter(
      (n) => n !== walkName(p),
    ),
    category: p.category,
    lat: p.lat,
    lng: p.lng,
    coord_system: "WGS84",
    country: p.country || draft.city.country,
    mainlandCityVerified: p.mainlandCityVerified,
    city: draft.city.name,
    source: p.source,
    source_url: p.source_url,
    license: p.license,
  }));
}

export function installCityWalkRoutes(
  app,
  {
    auth,
    travelHabit,
    query = dbQuery,
    transaction = dbTransaction,
    loadCity = cityWalkCatalog,
    nearby = nearbyWalkPlaces,
    verify = walkingRouter.verify,
  },
) {
  const job = createReadJobs(),
    routeJob = createReadJobs({ ttlMs: 30_000 });
  const draftFor = async (id, user, c = { query }, lock = false) => {
    const row = (
      await c.query(
        "SELECT * FROM citywalk_drafts WHERE id=$1 AND user_id=$2 AND expires_at>now()" +
          (lock ? " FOR UPDATE" : ""),
        [z.uuid().parse(id), user],
      )
    ).rows[0];
    if (!row) throw error("地点列表已过期，请重新选择城市", 410);
    return row;
  };
  const poolFor = (draft, ids) => {
    if (new Set(ids).size !== ids.length) throw error("片区不能重复");
    const groups = ids.map((id) =>
      draft.catalog.clusters.find((g) => g.id === id),
    );
    if (groups.some((g) => !g)) throw error("片区已变化，请重新选择");
    return groups;
  };

  const own = async (id, user) => {
    z.uuid().parse(id);
    const row = (
      await query("SELECT * FROM citywalks WHERE id=$1 AND user_id=$2", [
        id,
        user,
      ])
    ).rows[0];
    if (!row) throw error("这条 CityWalk 不存在", 404);
    return row;
  };
  app.get("/api/citywalk/catalog/:cityId", auth, async (req, res) => {
    const cityId = z.string().min(1).max(80).parse(req.params.cityId);
    const result = job(req.user.id + ":" + cityId, async () => {
      const city = (
        await query(
          "SELECT id,name,country,province,lat,lng,timezone FROM places WHERE id=$1 AND category='city'",
          [cityId],
        )
      ).rows[0];
      if (!city) throw error("请从列表选择城市", 404);
      const data = await loadCity(city, req.user, travelHabit),
        draftId = randomUUID();
      await query("DELETE FROM citywalk_drafts WHERE expires_at < now()");
      await query(
        "INSERT INTO citywalk_drafts(id,user_id,city,catalog) VALUES($1,$2,$3,$4)",
        [
          draftId,
          req.user.id,
          JSON.stringify(city),
          JSON.stringify({ clusters: data.clusters }),
        ],
      );
      return { ...data, draftId };
    });
    res.status(result.status === "loading" ? 202 : 200).json(result);
  });
  app.post("/api/citywalk/drafts/:id/nearby", auth, async (req, res) => {
    const b = z
      .object({
        clusterIds: z.array(z.string().min(1).max(200)).min(1).max(50),
        anchorId: z.string().min(1).max(200),
        walkId: z.uuid().optional(),
      })
      .strict()
      .parse(req.body);
    const draft = await draftFor(req.params.id, req.user.id),
      groups = poolFor(draft, b.clusterIds),
      previous = b.walkId ? await own(b.walkId, req.user.id) : null;
    const anchor =
      groups.flatMap((g) => g.members).find((p) => p.id === b.anchorId) ||
      (previous?.city.id === draft.city.id
        ? previous.stops.find((p) => p.id === b.anchorId)
        : null);
    if (!anchor) throw error("请从当前路线选择下一站的起点");
    const key = createHash("sha256")
        .update(JSON.stringify([b.anchorId, [...b.clusterIds].sort()]))
        .digest("hex"),
      cached = draft.catalog.nearby?.[key];
    if (cached) return res.json({ status: "ready", items: cached.items });
    const result = job(
      "nearby:" + req.user.id + ":" + draft.id + ":" + key,
      async () => {
        let items = await nearby(anchor, draft.city);
        await transaction(async (c) => {
          const fresh = await draftFor(draft.id, req.user.id, c, true),
            g = poolFor(fresh, b.clusterIds)[0];
          const members = new Map(
            uniqueWalkPlaces([...g.members, anchor, ...items]).map((p) => [
              p.id,
              p,
            ]),
          );
          items = items.filter((p) => members.has(p.id));
          if (members.size > 2000)
            throw error("这条路线的候选较多，请另建一条路线");
          g.members = [...members.values()];
          g.memberCount = g.members.length;
          (fresh.catalog.nearby ||= {})[key] = { items };
          await c.query("UPDATE citywalk_drafts SET catalog=$2 WHERE id=$1", [
            fresh.id,
            JSON.stringify(fresh.catalog),
          ]);
        });
        return { status: "ready", items };
      },
    );
    res.status(result.status === "loading" ? 202 : 200).json(result);
  });
  app.post("/api/citywalk/preview", auth, async (req, res) => {
    const b = z
      .object({
        draftId: z.uuid(),
        clusterIds: z.array(z.string().min(1).max(200)).min(1).max(50),
        stopIds: z.array(z.string().min(1).max(200)).min(2).max(100),
        startId: z.string().min(1).max(200),
        walkId: z.uuid().optional(),
      })
      .strict()
      .parse(req.body);
    const draft = await draftFor(b.draftId, req.user.id),
      previous = b.walkId ? await own(b.walkId, req.user.id) : null,
      stops = selectedWalk(draft, b, previous);
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          req.user.id,
          b.draftId,
          stops.map((p) => [p.id, p.lat, p.lng]),
        ]),
      )
      .digest("hex");
    const result = routeJob(key, async () => ({
      status: "ready",
      stops,
      route: await verify(stops),
    }));
    res.status(result.status === "loading" ? 202 : 200).json(result);
  });
  app.get("/api/citywalks", auth, async (req, res) => {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(req.query.limit || 10);
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .parse(req.query.offset || 0);
    const rows = (
      await query(
        `SELECT id,title,city,stops,distance_m,version,updated_at FROM citywalks WHERE user_id=$1 ORDER BY updated_at DESC,id LIMIT $2 OFFSET $3`,
        [req.user.id, limit, offset],
      )
    ).rows;
    res.json(
      rows.map((r) => ({
        ...r,
        stops: r.stops.map((p) => ({ id: p.id, name: p.name })),
      })),
    );
  });
  app.get("/api/citywalks/:id", auth, async (req, res) =>
    res.json(await own(req.params.id, req.user.id)),
  );
  async function save(req, res) {
    const input = inputSchema.parse(req.body),
      updating = req.method === "PUT";
    if (updating && req.params.id !== input.id) throw error("路线编号不一致");
    if (!updating) {
      const exists = (
        await query("SELECT id FROM citywalks WHERE id=$1", [input.id])
      ).rows[0];
      if (exists) return res.json(await own(input.id, req.user.id));
    }
    const previous = updating ? await own(input.id, req.user.id) : null;
    const draft = (
      await query(
        "SELECT * FROM citywalk_drafts WHERE id=$1 AND user_id=$2 AND expires_at>now()",
        [input.draftId, req.user.id],
      )
    ).rows[0];
    if (!draft) throw error("景点列表已过期，请重新打开编辑页", 410);
    const stops = selectedWalk(draft, input, previous),
      verifiedRoute = await verify(stops);
    if (
      verifiedRoute.status !== "verified" ||
      !Number.isFinite(verifiedRoute.distanceM) ||
      verifiedRoute.distanceM < 0
    )
      throw error("暂时无法核验步行距离，只能预览，请稍后重试", 503);
    if (verifiedRoute.blocked || verifiedRoute.distanceM >= 15000)
      throw error("步行路线达到 15 公里，请减少地点", 422);
    const distance = Math.round(verifiedRoute.distanceM);
    let result;
    if (updating) {
      if (!input.version) throw error("缺少路线版本");
      result = await query(
        `UPDATE citywalks SET title=$3,city=$4,stops=$5,cluster_ids=$6,distance_m=$7,verified_route=$9,version=version+1,updated_at=now() WHERE id=$1 AND user_id=$2 AND version=$8 RETURNING *`,
        [
          input.id,
          req.user.id,
          input.title,
          JSON.stringify(draft.city),
          JSON.stringify(stops),
          input.clusterIds,
          distance,
          input.version,
          JSON.stringify(verifiedRoute),
        ],
      );
      if (!result.rowCount)
        throw error("路线已在其他页面修改，请重新打开后编辑", 409);
    } else {
      result = await query(
        `INSERT INTO citywalks(id,user_id,title,city,stops,cluster_ids,distance_m,verified_route) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING RETURNING *`,
        [
          input.id,
          req.user.id,
          input.title,
          JSON.stringify(draft.city),
          JSON.stringify(stops),
          input.clusterIds,
          distance,
          JSON.stringify(verifiedRoute),
        ],
      );
      if (!result.rowCount) return res.json(await own(input.id, req.user.id));
    }
    res.json(result.rows[0]);
  }
  app.post("/api/citywalks", auth, save);
  app.put("/api/citywalks/:id", auth, save);
}
