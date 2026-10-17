import { z } from "zod";
import {
  readMemory,
  saveMemory,
  styleSchema,
  styleLabels,
  valueLabels,
} from "../agent/memory.mjs";
import { interests } from "../planner.mjs";
const page = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
const kind = z.enum(["favorites", "browsing"]);
const from = {
  favorites: `FROM reactions r JOIN posts p ON p.id=r.post_id WHERE r.user_id=$1 AND r.kind='save' AND p.hidden_at IS NULL`,
  browsing: `FROM browse_events r JOIN posts p ON p.id=r.post_id WHERE r.user_id=$1 AND p.hidden_at IS NULL`,
};
export function installPersonalCenter(app, { auth, query, transaction }) {
  app.get("/api/me/style", auth, async (req, res) => {
    const memory = await readMemory(query, req.user.id);
    const options = {
      interests,
      pace: ["relaxed", "balanced", "full"],
      transport: ["balanced", "fewTransfers", "fewWalking"],
      crowd: ["avoid", "balanced", "lively"],
      revisit: ["new", "either"],
    };
    res.json({
      values: {
        pace: "balanced",
        transport: "balanced",
        crowd: "balanced",
        revisit: "new",
        ...req.user.preferences,
        ...Object.fromEntries(
          memory.filter((m) => m.active).map((m) => [m.dimension, m.value]),
        ),
      },
      versions: Object.fromEntries(memory.map((m) => [m.dimension, m.version])),
      options,
      labels: styleLabels,
      valueLabels,
    });
  });
  app.put("/api/me/style", auth, async (req, res) => {
    const b = z
      .object({
        values: styleSchema,
        versions: z.partialRecord(
          z.enum(["pace", "interests", "transport", "crowd", "revisit"]),
          z.number().int().min(0),
        ),
      })
      .strict()
      .parse(req.body);
    await saveMemory(
      transaction,
      req.user.id,
      b.values,
      "用户在旅行偏好页面主动保存",
      b.versions,
    );
    res.json({ ok: true });
  });
  app.get("/api/me/overview", auth, async (req, res) => {
    const { rows } = await query(
      `SELECT
   (SELECT count(*)::int FROM trips WHERE user_id=$1) trips,
   (SELECT count(*)::int FROM citywalks WHERE user_id=$1) walks,
   (SELECT count(*)::int ${from.favorites}) favorites,
   (SELECT count(DISTINCT p.id)::int ${from.browsing}) browsing,
   (SELECT count(*)::int FROM inbox_messages WHERE user_id=$1 AND read_at IS NULL) unread`,
      [req.user.id],
    );
    res.json(rows[0]);
  });
  app.get("/api/me/library/:kind", auth, async (req, res) => {
    const type = kind.parse(req.params.kind),
      { limit, offset } = page.parse(req.query);
    const rows = (
      await query(
        `SELECT p.id,p.title,p.tags,max(r.created_at) saved_at ${from[type]}
   GROUP BY p.id,p.title,p.tags ORDER BY saved_at DESC,p.id LIMIT $2 OFFSET $3`,
        [req.user.id, limit + 1, offset],
      )
    ).rows;
    res.json({ items: rows.slice(0, limit), hasMore: rows.length > limit });
  });
  app.get("/api/me/library/:kind/:id", auth, async (req, res) => {
    const type = kind.parse(req.params.kind),
      id = z.uuid().parse(req.params.id);
    // Details are accessible only through the current user's own record, never by arbitrary ID.
    const row = (
      await query(
        `SELECT p.id,p.title,p.body,p.tags,p.snapshot ${from[type]} AND p.id=$2 LIMIT 1`,
        [req.user.id, id],
      )
    ).rows[0];
    if (!row) return res.status(404).json({ error: "这条内容已不可用" });
    res.json(row);
  });
  app.delete("/api/me/library/favorites/:id", auth, async (req, res) => {
    await query(
      "DELETE FROM reactions WHERE user_id=$1 AND post_id=$2 AND kind='save'",
      [req.user.id, z.uuid().parse(req.params.id)],
    );
    res.json({ ok: true });
  });
  app.get("/api/me/report", auth, async (req, res) => {
    // Aggregate in PostgreSQL: never pull every historical plan into Node memory.
    const totals = (
      await query(
        `SELECT count(*) FILTER(WHERE status='completed')::int completed,
   count(*) FILTER(WHERE status='planned')::int planned FROM trips WHERE user_id=$1`,
        [req.user.id],
      )
    ).rows[0];
    const cities = (
      await query(
        `SELECT DISTINCT city->>'name' name FROM trips t
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.plan->'cities')='array' THEN t.plan->'cities' ELSE '[]'::jsonb END) city
   WHERE t.user_id=$1 AND t.status='completed' AND city->>'name' IS NOT NULL ORDER BY name LIMIT 200`,
        [req.user.id],
      )
    ).rows.map((r) => r.name);
    const {
      rows: [metrics],
    } = await query(
      `SELECT
   (SELECT count(*)::int FROM citywalks WHERE user_id=$1) walks,
   (SELECT count(*)::int FROM (SELECT place_id FROM user_place_presence WHERE user_id=$1 UNION SELECT place_id FROM user_place_visits WHERE user_id=$1 AND visited) v) "visitedPlaces",
   (SELECT coalesce(sum(jsonb_array_length(CASE WHEN jsonb_typeof(d->'stops')='array' THEN d->'stops' ELSE '[]'::jsonb END)),0)::int
    FROM trips t CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.plan->'days')='array' THEN t.plan->'days' ELSE '[]'::jsonb END) d
    WHERE t.user_id=$1 AND t.status='completed') stops`,
      [req.user.id],
    );
    res.json({
      ...totals,
      ...metrics,
      cities,
      interests: req.user.preferences?.interests || [],
      summary: totals.completed
        ? `已标记完成 ${totals.completed} 段行程，涉及 ${cities.length} 座城市。`
        : "第一段旅行，等你出发。",
      source:
        "行程完成状态由用户标记；到访地点来自已有到访记录，未把计划中的景点当作实际到访。",
    });
  });
}
