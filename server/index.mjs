import {guestMapStyle} from '../public/guest-policy.js';
import {installDraftRoutes} from './social/drafts.mjs';
import {installSocialMedia} from './social/media.mjs';
import {installWritingRoutes} from './social/writing.mjs';
import {installSocialCommunity,socialNotify} from './social/community.mjs';
import {installPersonalCenter} from './services/personal-center.mjs';
import {installClassicWalkRoutes,seedClassicWalks} from './services/classic-citywalks.mjs';
import { installDiscoveryRoutes, publicRoute } from "./services/discovery.mjs";
import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { randomUUID } from "node:crypto";
import { createAccounts, requireUser as auth } from "./auth.mjs";
import { createMailer } from "./mail.mjs";
import { createEventRecorder } from './operations/events.mjs';
import { installOperationsRoutes } from './operations/routes.mjs';
import { installAdminAccess } from './operations/admin-access.mjs';
import { installAccessRoutes } from './operations/access-routes.mjs';
import { installUserInsights } from './operations/user-insights.mjs';
import { installAnalytics } from './operations/analytics.mjs';
import { installAgentInsights } from './operations/agent-insights.mjs';
import {installModeration} from './operations/moderation.mjs';
import {installMaintenance} from './operations/maintenance.mjs';
import {installArchiveRoutes} from './operations/archive-routes.mjs';
import {archiveExecutors} from './operations/event-archive.mjs';
import {installCommunityInteractions} from './services/community-interactions.mjs';
import {installPlaceQuality} from './operations/place-quality.mjs';
import { installJourneyInsights } from './operations/journey-insights.mjs';
import { withRequestContext } from './operations/request-context.mjs';
import {installMessageInsights} from './operations/message-insights.mjs';
import { installInboxRoutes } from './operations/inbox.mjs';
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { pool, query, transaction, migrate, savePlace } from "./db.mjs";
import { seed } from "./seed.mjs";
import { catalogQuery, siteQuery, catalogRequest, resolvePlace } from "./catalog.mjs";
import { searchCandidates } from './services/place-candidates.mjs';
import { nearbyRecommendations } from './services/nearby-recommendations.mjs';
import { installJourneyRoutes } from './services/journey-service.mjs';
import { installCityWalkRoutes } from './services/citywalk-service.mjs';
import { installTripServiceRoutes } from './services/trip-services.mjs';
import { installAgentRoutes } from './agent/routes.mjs';
import { memoryPreferences } from './agent/memory.mjs';
import { openingOnDate, validateOpeningDate } from './opening-hours.mjs';
import { createRouteSelection, routingProvider } from './route-selection.mjs';
const routeSelections = createRouteSelection();
import {
  datesBetween,
  makePlan,
  applyEdit,
  interests,
  distance,
} from "./planner.mjs";
import {
  providerStatus,
  personalizedQuestions,
  llmJSON,
  trainSearch,
  flightSearch,
  route,
  matchPlace,
} from "./providers.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = express(),
  production = process.env.NODE_ENV === "production";
app.disable("x-powered-by");
// Only a configured, private reverse proxy may supply the client address.
// Never use `true`: direct clients could then spoof rate-limit identities.
app.set("trust proxy", process.env.TRUST_PROXY || false);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://tile.openstreetmap.org", "https://*.tile.openstreetmap.org"],
        connectSrc: ["'self'"],
        upgradeInsecureRequests: production ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(express.json({ limit: "2mb" }), cookieParser());
const rate = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rate) if (v.until < now) rate.delete(k);
}, 60000).unref();
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const key = req.ip + (req.path.startsWith("/auth/") ? ":auth" : ":api"),
    limit = key.endsWith(":auth") ? 30 : 500;
  let v = rate.get(key);
  if (!v || v.until < Date.now()) v = { count: 0, until: Date.now() + 60000 };
  rate.set(key, v);
  if (++v.count > limit)
    return res.status(429).json({ error: "操作太快，请稍后重试" });
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    (req.get("X-Seatraces") !== "1" || req.get("Sec-Fetch-Site") === "cross-site")
  )
    return res.status(403).json({ error: "请求来源校验失败" });
  next();
});
const accounts = createAccounts({ query, transaction, production, mailer: createMailer() });
app.use(['/api','/_AMapService'], accounts.attach);
const operationEvents=createEventRecorder({query});
app.use('/api',operationEvents.middleware);
installAdminAccess(app,{query,transaction,production});
app.use('/api', accounts.gate, accounts.router);
app.use('/api',withRequestContext);
const logExports=installOperationsRoutes(app,{auth,query,transaction,events:operationEvents});
installAccessRoutes(app,{query,transaction,events:operationEvents});
installUserInsights(app,{query,events:operationEvents});
installAnalytics(app,{query,transaction,events:operationEvents});
installAgentInsights(app,{query,events:operationEvents});
installJourneyInsights(app,{query,events:operationEvents});
installInboxRoutes(app,{auth,query,transaction,events:operationEvents});
installMessageInsights(app,{query,events:operationEvents});
installPlaceQuality(app,{query,events:operationEvents,catalogRequest});
installModeration(app,{auth,query,transaction,events:operationEvents});
const maintenance=installMaintenance(app,{query,transaction,events:operationEvents,extraExecutors:{...archiveExecutors({query,transaction,events:operationEvents}),log_export:logExports.execute}});
installArchiveRoutes(app,{query,transaction,events:operationEvents});
installCommunityInteractions(app,{auth,query,transaction,
 onReaction:async(c,{id,userId,kind,active})=>{if(!active||kind==='save')return;const p=(await c.query('SELECT user_id FROM posts WHERE id=$1',[id])).rows[0];if(p)await socialNotify(c,{owner:p.user_id,actor:userId,post:id,kind,key:id});},
 onComment:async(c,{id,userId,commentId})=>{const p=(await c.query('SELECT user_id FROM posts WHERE id=$1',[id])).rows[0];if(p)await socialNotify(c,{owner:p.user_id,actor:userId,post:id,kind:'comment',key:commentId});}
});
installSocialCommunity(app,{auth,query,transaction});
installPersonalCenter(app,{auth,query,transaction});
installDraftRoutes(app,{auth,query,transaction});
installSocialMedia(app,{auth,query,transaction});
installWritingRoutes(app,{auth,query,transaction});
app.use('/_AMapService', (req,res,next)=>{
  if(!guestMapStyle(req.path,req.method))return auth(req,res,next);
  const key=req.ip+':map',now=Date.now();let v=rate.get(key);
  if(!v||v.until<now)v={count:0,until:now+60000};rate.set(key,v);
  if(++v.count>120)return res.status(429).json({error:'地图请求过快，请稍后重试'});
  next();
});
const admin = (req, res, next) => req.user?.role === 'admin'
  ? next() : res.status(403).json({ error: '需要管理员权限' });
app.get('/api/health', async (req, res) => {
  await query('SELECT 1');
  res.json({ ok: true, database: 'PostgreSQL', version: '0.1.0' });
});
app.delete("/api/me/history", auth, async (req, res) => {
  await query("DELETE FROM browse_events WHERE user_id=$1", [req.user.id]);
  res.json({ ok: true });
});
app.get("/api/status", async (req, res) => {
  const counts = (
    await query(
      "SELECT category,data_status,count(*)::int n FROM places GROUP BY category,data_status",
    )
  ).rows;
  const used = (
    await query(
      "SELECT COALESCE(sum(reserved_cny),0) n FROM api_usage WHERE created_at>=date_trunc('month',now())",
    )
  ).rows[0].n;
  const ext = (
    await query("SELECT extname FROM pg_extension WHERE extname='postgis'")
  ).rowCount;
  res.json({
    providers: providerStatus(),
    counts,
    database: "PostgreSQL",
    spatial: ext ? "PostGIS" : "经纬度 + 城市索引（本机）",
    budget: {
      limit: Number(process.env.API_MONTHLY_BUDGET_CNY || 200),
      reserved: Number(used),
      note: "请求预留估算，并非供应商账单",
    },
    demo: true,
  });
});
app.get("/api/regions", async (req, res) => {
  const country = z.string().max(4).optional().parse(req.query.country);
  const rows = country
    ? (
        await query(
          "SELECT DISTINCT province FROM places WHERE country=$1 AND category='city' ORDER BY province",
          [country],
        )
      ).rows
    : (
        await query(
          "SELECT country,count(*)::int count FROM places WHERE category='city' GROUP BY country ORDER BY country",
        )
      ).rows;
  res.json(rows);
});
app.get('/api/catalog/coverage', async (req,res)=>res.json(await catalogRequest('/coverage')));
app.get('/api/catalog/site-coverage', async (req,res)=>res.json(await catalogRequest('/site-coverage')));
app.get('/api/catalog/site', async (req,res)=>res.json(await catalogRequest('/site',siteQuery.parse(req.query))));
app.get('/api/catalog/hierarchy-coverage', async (req,res)=>res.json(await catalogRequest('/hierarchy-coverage')));
app.get('/api/catalog/entity-coverage', async (req,res)=>res.json(await catalogRequest('/entity-coverage')));
app.get('/api/catalog/hierarchy', async (req,res)=>res.json(await catalogRequest('/hierarchy',siteQuery.parse(req.query))));
app.get('/api/maps/config',(req,res)=>res.json({enabled:Boolean(process.env.AMAP_JS_KEY&&process.env.AMAP_JS_SECURITY_CODE),jsKey:process.env.AMAP_JS_KEY||null}));
app.get('/api/maps/google/config',auth,(req,res)=>res.json({
  enabled:process.env.OVERSEAS_MAP_PROVIDER==='google'&&Boolean(process.env.GOOGLE_MAPS_JS_KEY),
  jsKey:process.env.OVERSEAS_MAP_PROVIDER==='google'?(process.env.GOOGLE_MAPS_JS_KEY||null):null,
}));
// Only map style requests are forwarded; this is not an open REST proxy.
app.get(['/_AMapService/v4/map/styles','/api/_AMapService/v4/map/styles'], async(req,res)=>{
  if(!process.env.AMAP_JS_KEY||!process.env.AMAP_JS_SECURITY_CODE)return res.status(503).json({error:'地图显示未配置'});
  const url=new URL('https://webapi.amap.com/v4/map/styles');
  for(const [k,v] of Object.entries(req.query))if(typeof v==='string'&&v.length<2000&&!['key','jscode'].includes(k))url.searchParams.set(k,v);
  url.searchParams.set('key',process.env.AMAP_JS_KEY);url.searchParams.set('jscode',process.env.AMAP_JS_SECURITY_CODE);
  // Amap checks the browser origin against the JS Key's domain whitelist.
  // Forward only that origin, never page paths, queries, cookies or credentials.
  let referer;
  try { const source=new URL(req.get('referer')); if(['http:','https:'].includes(source.protocol))referer=source.origin+'/'; } catch {}
  const response=await fetch(url,{signal:AbortSignal.timeout(10000),headers:referer?{Referer:referer}:{}});
  res.status(response.status).type(response.headers.get('content-type')||'application/json').send(Buffer.from(await response.arrayBuffer()));
});
app.get('/api/catalog/search', async (req,res)=>res.json(await catalogRequest('/places',catalogQuery.parse(req.query))));
app.get('/api/catalog/nearby', async (req,res)=>res.json(await nearbyRecommendations(req.query)));
// Explicit authenticated POST because insufficient local results may incur one paid call.
app.post('/api/catalog/candidates', auth, async (req,res)=>res.json(await searchCandidates(req.body)));
app.get('/api/catalog/place', async (req,res)=>{
  const id=z.string().regex(/^osm:(node|way|relation)\/\d{1,20}$/).parse(req.query.id);
  const item=await resolvePlace(id);
  if(!item)return res.status(404).json({error:'地点不存在或不允许访问'});
  res.json(item);
});
app.get('/api/catalog/opening', async (req,res)=>{
  const id=z.string().regex(/^osm:(node|way|relation)\/\d{1,20}$/).parse(req.query.id);
  const date=validateOpeningDate(z.string().parse(req.query.date));
  const item=await resolvePlace(id);
  if(!item)return res.status(404).json({error:'地点不存在或不允许访问'});
  res.json(await openingOnDate(item,date));
});
app.get("/api/places", async (req, res) => {
  const b = z
    .object({
      q: z.string().max(100).default(""),
      category: z
        .enum(["city", "attraction", "hotel", "hostel", "rest", "station"])
        .optional(),
      country: z.string().max(4).optional(),
      province: z.string().max(100).optional(),
      city: z.string().max(100).optional(),
    })
    .parse(req.query);
  const values = [],
    where = [];
  const add = (s, v) => {
    values.push(v);
    where.push(s.replace("?", `$${values.length}`));
  };
  if (b.q) add("search_text ILIKE ?", "%" + b.q.replace(/[%_\\]/g, "") + "%");
  for (const key of ["category", "country", "province", "city"])
    if (b[key]) add(key + "=?", b[key]);
  res.json(
    (
      await query(
        "SELECT * FROM places" +
          (where.length ? " WHERE " + where.join(" AND ") : "") +
          " ORDER BY (source='SeaTraces 编辑示例') DESC,name LIMIT 60",
        values,
      )
    ).rows,
  );
});
app.get("/api/nearby", async (req, res) => {
  const b = z
    .object({
      lat: z.coerce.number().min(-90).max(90),
      lng: z.coerce.number().min(-180).max(180),
    })
    .parse(req.query);
  const candidates = (
    await query(
      "SELECT * FROM places WHERE category='city' AND lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4 LIMIT 500",
      [b.lat - 3, b.lat + 3, b.lng - 3, b.lng + 3],
    )
  ).rows;
  candidates.sort((a, c) => distance(a, b) - distance(c, b));
  res.json({ place: candidates[0] || null });
});
async function travelHabit(user) {
  const remembered = await memoryPreferences(query,user.id);
  const preferences = {...user.preferences,...remembered};
  const weights = {};
  for (const tag of preferences.interests || []) weights[tag] = 5;
  const completed = (
    await query(
      "SELECT request->'interests' tags FROM trips WHERE user_id=$1 AND status='completed'",
      [user.id],
    )
  ).rows;
  for (const row of completed)
    for (const tag of row.tags || []) weights[tag] = (weights[tag] || 0) + 2;
  const reactions = (
    await query(
      "SELECT p.tags,r.kind FROM reactions r JOIN posts p ON p.id=r.post_id WHERE r.user_id=$1 AND p.hidden_at IS NULL",
      [user.id],
    )
  ).rows;
  for (const row of reactions)
    for (const tag of row.tags)
      weights[tag] =
        (weights[tag] || 0) +
        ({ save: 3, like: 1, recommend: 2 }[row.kind] || 0);
  const events = (
    await query(
      "SELECT p.tags,b.dwell_seconds FROM browse_events b JOIN posts p ON p.id=b.post_id WHERE b.user_id=$1 AND p.hidden_at IS NULL AND b.day>CURRENT_DATE-30",
      [user.id],
    )
  ).rows;
  for (const row of events)
    for (const tag of row.tags)
      weights[tag] =
        (weights[tag] || 0) + Math.min(row.dwell_seconds / 120, 0.5);
  return {
    ...preferences,
    tagWeights: Object.fromEntries(
      Object.entries(weights)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10),
    ),
    completedTrips: completed.length,
  };
}
installJourneyRoutes(app,{auth,travelHabit});
installTripServiceRoutes(app,{auth});
installCityWalkRoutes(app,{auth,travelHabit});
installClassicWalkRoutes(app,{auth,events:operationEvents});
installDiscoveryRoutes(app,{auth});
installAgentRoutes(app,{auth,query,transaction,port:()=>server.address().port});
app.get("/api/questions", auth, async (req, res) =>
  res.json(await personalizedQuestions(await travelHabit(req.user))),
);
const tripRequest = z.object({
  origin: z.string().trim().min(1).max(150),
  cityIds: z.array(z.string().min(1).max(80)).min(1).max(8),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  interests: z.array(z.enum(interests)).max(10).default(["人文", "自然"]),
  pace: z.enum(["relaxed", "balanced", "full"]).default("balanced"),
  transport: z
    .enum(["balanced", "fewTransfers", "fewWalking"])
    .default("balanced"),
});
app.post("/api/trips", auth, async (req, res) => {
  const b = tripRequest.parse(req.body);
  datesBetween(b.start, b.end);
  b.cityIds = [...new Set(b.cityIds)];
  const cities = (
    await query("SELECT * FROM places WHERE category='city' AND id=ANY($1)", [
      b.cityIds,
    ])
  ).rows.sort((a, c) => b.cityIds.indexOf(a.id) - b.cityIds.indexOf(c.id));
  if (cities.length !== b.cityIds.length)
    return res.status(400).json({ error: "目的地不存在，请从列表选择" });
  const places = (
    await query(
      "SELECT * FROM places WHERE city=ANY($1) AND category<>'city'",
      [cities.map((x) => x.name)],
    )
  ).rows;
  const plan = makePlan(b, cities, places),
    id = randomUUID(),
    title =
      cities.map((x) => x.name).join(" · ") + ` ${plan.days.length} 日漫游`;
  await transaction(async (c) => {
    await c.query(
      "INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,$3,$4,$5)",
      [id, req.user.id, title, JSON.stringify(b), JSON.stringify(plan)],
    );
    await c.query(
      "INSERT INTO trip_versions(trip_id,version,plan,reason) VALUES($1,1,$2,$3)",
      [id, JSON.stringify(plan), "创建行程"],
    );
  });
  res
    .status(201)
    .json((await query("SELECT * FROM trips WHERE id=$1", [id])).rows[0]);
});
app.get("/api/trips", auth, async (req, res) => {
  if (req.query.summary === '1') {
    const options=z.object({limit:z.coerce.number().int().min(1).max(100).default(11),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).parse(req.query);
    return res.json((await query(`SELECT id,title,created_at,updated_at,status,
      jsonb_build_object('start',request->'start','end',request->'end') AS request,
      jsonb_build_object('schemaVersion',plan->'schemaVersion','generatedAt',plan->'generatedAt') AS plan
      FROM trips WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
      [req.user.id,options.limit,options.offset])).rows);
  }
  res.json(
    (
      await query(
        "SELECT * FROM trips WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100",
        [req.user.id],
      )
    ).rows,
  );
});
async function ownTrip(id, user, c = pool, lock = false) {
  z.uuid().parse(id);
  const t = (
    await c.query(
      "SELECT * FROM trips WHERE id=$1 AND user_id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [id, user],
    )
  ).rows[0];
  if (!t) throw Object.assign(new Error("行程不存在"), { status: 404 });
  return t;
}
app.get("/api/trips/:id", auth, async (req, res) =>
  res.json(await ownTrip(req.params.id, req.user.id)),
);
app.get("/api/trips/:id/versions", auth, async (req, res) => {
  await ownTrip(req.params.id, req.user.id);
  res.json(
    (
      await query(
        "SELECT version,reason,created_at FROM trip_versions WHERE trip_id=$1 ORDER BY version DESC",
        [req.params.id],
      )
    ).rows,
  );
});
const operationSchema = z.object({
  type: z.enum(["lock", "remove", "replace", "add", "move"]),
  day: z.number().int().min(0).max(29),
  placeId: z.string().max(80).optional(),
  newPlaceId: z.string().max(80).optional(),
  to: z.number().int().min(0).max(20).optional(),
});
app.patch("/api/trips/:id", auth, async (req, res) => {
  const b = z
    .object({
      version: z.number().int().positive(),
      operation: operationSchema.optional(),
      restoreVersion: z.number().int().positive().optional(),
      status: z.enum(["planned", "completed"]).optional(),
    })
    .refine(
      (x) =>
        [x.operation, x.restoreVersion, x.status].filter(Boolean).length === 1,
    )
    .parse(req.body);
  const result = await transaction(async (c) => {
    const t = await ownTrip(req.params.id, req.user.id, c, true);
    if (t.version !== b.version)
      throw Object.assign(new Error("行程已更新，请刷新后再试"), {
        status: 409,
      });
    let plan = t.plan,
      reason = "状态更新";
    if (b.operation) {
      const ps = (
        await c.query(
          "SELECT * FROM places WHERE category='attraction' AND city=ANY($1)",
          [t.plan.cities.map((x) => x.name)],
        )
      ).rows;
      plan = applyEdit(plan, b.operation, ps);
      reason = b.operation.type;
    }
    if (b.restoreVersion) {
      const old = (
        await c.query(
          "SELECT plan FROM trip_versions WHERE trip_id=$1 AND version=$2",
          [t.id, b.restoreVersion],
        )
      ).rows[0];
      if (!old) throw Object.assign(new Error("版本不存在"), { status: 404 });
      plan = old.plan;
      reason = "恢复版本 " + b.restoreVersion;
    }
    await c.query(
      "INSERT INTO trip_versions(trip_id,version,plan,reason) VALUES($1,$2,$3,$4)",
      [t.id, t.version + 1, JSON.stringify(plan), reason],
    );
    return (
      await c.query(
        "UPDATE trips SET plan=$1,version=version+1,status=$2,updated_at=now() WHERE id=$3 RETURNING *",
        [JSON.stringify(plan), b.status || t.status, t.id],
      )
    ).rows[0];
  });
  res.json(result);
});
app.post("/api/trips/:id/assistant", auth, async (req, res) => {
  const { text: input, day } = z
      .object({
        text: z.string().trim().min(1).max(500),
        day: z.number().int().min(0).max(29),
      })
      .parse(req.body),
    t = await ownTrip(req.params.id, req.user.id);
  let operation;
  const target = t.plan.days[day];
  if (!target) return res.status(400).json({ error: "日期不存在" });
  const candidates = (
    await query(
      "SELECT id,name FROM places WHERE city=$1 AND category='attraction'",
      [target.city],
    )
  ).rows;
  if (process.env.DEEPSEEK_API_KEY) {
    const parsed = await llmJSON(
      '仅建议一个操作，返回 {"operation":{"type":"remove|replace|add|move","day":0,"placeId":"已有 id","newPlaceId":"候选 id","to":0}}。禁止修改锁定地点。',
      {
        request: input,
        day,
        stops: target.stops.map((p) => ({
          id: p.id,
          name: p.name,
          locked: p.locked,
        })),
        candidates,
      },
    );
    operation = operationSchema.parse(parsed.operation);
    if (operation.day !== day)
      throw Object.assign(new Error("模型尝试修改其他日期，已拒绝"), {
        status: 400,
      });
  } else {
    const matched = target.stops.find((p) => input.includes(p.name));
    if (/删|不要|去掉/.test(input) && matched)
      operation = { type: "remove", day, placeId: matched.id };
    else if (/慢|少|轻松/.test(input)) {
      const p = [...target.stops].reverse().find((x) => !x.locked);
      if (p) operation = { type: "remove", day, placeId: p.id };
    } else if (/加|增加/.test(input)) {
      const p = candidates.find((x) => input.includes(x.name));
      if (p) operation = { type: "add", day, newPlaceId: p.id };
    } else if (/换|替/.test(input) && matched) {
      const p = candidates.find(
        (x) => input.includes(x.name) && x.id !== matched.id,
      );
      if (p)
        operation = {
          type: "replace",
          day,
          placeId: matched.id,
          newPlaceId: p.id,
        };
    }
  }
  if (!operation)
    return res.json({
      status: "clarify",
      message:
        "可以试试“这一天轻松一点”“去掉平江路”或“加上留园”。配置模型密钥后可理解更多表达。",
    });
  const ps = (
      await query(
        "SELECT * FROM places WHERE city=$1 AND category='attraction'",
        [target.city],
      )
    ).rows,
    preview = applyEdit(t.plan, operation, ps);
  res.json({
    status: "preview",
    source: process.env.DEEPSEEK_API_KEY ? "DeepSeek" : "本地规则助手",
    operation,
    version: t.version,
    preview,
    message: "已生成修改预览；确认后保存新版本。",
  });
});
app.post("/api/routes", auth, async (req, res) => {
  const b = z
    .object({
      from: z.string().max(80),
      to: z.string().max(80),
      strategy: z
        .enum(["balanced", "fewTransfers", "fewWalking", "fastest"])
        .default("balanced"),
      mode: z.enum(["walking", "transit", "driving", "cycling"]).default("walking"),
      departure: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
      departureTimeZone:z.string().max(100).optional(),
      fromMatchToken:z.string().min(1).max(2048).optional(),
      toMatchToken:z.string().min(1).max(2048).optional(),
    })
    .parse(req.body);
  if(b.departure) {
    datesBetween(b.departure.slice(0,10),b.departure.slice(0,10));
    if(Number(b.departure.slice(11,13))>23||Number(b.departure.slice(14))>59)
      return res.status(400).json({error:'出发时间无效'});
  }
  const [a,c] = await Promise.all([resolvePlace(b.from),resolvePlace(b.to)]);
  if (!a || !c) return res.status(404).json({ error: "地点不存在" });
  if(a.id===c.id)return res.status(400).json({error:'起点和终点不能相同'});
  const provider=routingProvider(a,c),selections={};
  if(b.fromMatchToken)selections.from=routeSelections.resolve(b.fromMatchToken,req.user.id,a.id,provider);
  if(b.toMatchToken)selections.to=routeSelections.resolve(b.toMatchToken,req.user.id,c.id,provider);
  const result=await route(a,c,b.strategy,b.mode,b.departure,b.departureTimeZone,selections);
  res.json({...result,endpointSelections:selections,
    ...(Object.keys(selections).length?{selectionNotice:'已使用你选择的地图候选；这不代表入口已核实，自有地点资料未改写。'}:{})});
});
app.post("/api/places/:id/match", auth, async (req, res) => {
  const p = await resolvePlace(req.params.id);
  if (!p) return res.status(404).json({ error: "地点不存在" });
  const result=await matchPlace(p);
  res.json({...result,items:result.items.map(({routing,...item})=>{
    if(!routing)return item;
    try{return {...item,...routeSelections.issue(req.user.id,p.id,routing)};}
    catch{return item;} // An incomplete provider reference remains view-only.
  })});
});
app.post("/api/transport", auth, async (req, res) => {
  const b = z
    .object({
      type: z.enum(["train", "flight"]),
      from: z.string().trim().min(1).max(50),
      to: z.string().trim().min(1).max(50),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .parse(req.body);
  datesBetween(b.date, b.date);
  res.json(await (b.type === "train" ? trainSearch(b) : flightSearch(b)));
});
app.post("/api/posts", auth, async (req, res) => {
  const b = z
      .object({
        tripId: z.uuid(),
        title: z.string().trim().min(1).max(100),
        body: z.string().trim().min(1).max(4000),
      })
      .parse(req.body),
    t = await ownTrip(b.tripId, req.user.id);
  const snapshot = publicRoute("journey", t);
  try {
    const r = await query(
      `INSERT INTO posts(id,user_id,trip_id,title,body,tags,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(user_id,trip_id) DO UPDATE SET title=excluded.title,body=excluded.body,tags=excluded.tags,snapshot=excluded.snapshot,auto_shared=false
       WHERE posts.auto_shared RETURNING *`,
      [
        randomUUID(),
        req.user.id,
        t.id,
        b.title,
        b.body,
        t.request.interests,
        JSON.stringify(snapshot),
      ],
    );
    if (!r.rowCount) return res.status(409).json({ error: "这条行程已经发布过了" });
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === "23505")
      return res.status(409).json({ error: "这条行程已经发布过了" });
    throw e;
  }
});
async function recommended(user) {
  const posts = (
    await query(
      `SELECT p.*,u.nickname,u.avatar,(SELECT count(*)::int FROM reactions r WHERE r.post_id=p.id AND kind='like') likes,(SELECT count(*)::int FROM reactions r WHERE r.post_id=p.id AND kind='save') saves,(SELECT count(*)::int FROM comments c WHERE c.post_id=p.id AND c.hidden_at IS NULL) comments FROM posts p JOIN users u ON p.user_id=u.id WHERE NOT p.auto_shared AND p.hidden_at IS NULL ORDER BY p.created_at DESC LIMIT 200`,
    )
  ).rows;
  let reactions = [],
    events = [],
    history = [];
  if (user) {
    reactions = (
      await query("SELECT * FROM reactions WHERE user_id=$1", [user.id])
    ).rows;
    events = (
      await query(
        "SELECT b.*,p.tags FROM browse_events b JOIN posts p ON b.post_id=p.id WHERE b.user_id=$1 AND p.hidden_at IS NULL AND b.day>CURRENT_DATE-30",
        [user.id],
      )
    ).rows;
    history = (
      await query(
        "SELECT request FROM trips WHERE user_id=$1 AND status='completed'",
        [user.id],
      )
    ).rows;
  }
  const weights = {};
  for (const tag of user?.preferences.interests || []) weights[tag] = 5;
  for (const h of history)
    for (const tag of h.request.interests)
      weights[tag] = (weights[tag] || 0) + 2;
  for (const r of reactions) {
    const p = posts.find((x) => x.id === r.post_id);
    for (const t of p?.tags || [])
      weights[t] =
        (weights[t] || 0) + { like: 1, save: 3, recommend: 2 }[r.kind];
  }
  for (const e of events)
    for (const t of e.tags)
      weights[t] = (weights[t] || 0) + Math.min(e.dwell_seconds / 120, 0.5);
  const peer = new Map();
  if (user) {
    const peers = (
      await query(
        `SELECT other.post_id,count(*)::int n FROM reactions mine JOIN reactions shared ON shared.post_id=mine.post_id AND shared.user_id<>mine.user_id JOIN reactions other ON other.user_id=shared.user_id WHERE mine.user_id=$1 AND mine.kind='save' AND shared.kind='save' AND other.kind='save' GROUP BY other.post_id`,
        [user.id],
      )
    ).rows;
    peers.forEach((x) => peer.set(x.post_id, Math.min(x.n, 5)));
  }
  return posts
    .map((p) => ({
      ...p,
      isOwn: p.user_id === user?.id,
      mine: reactions.filter((r) => r.post_id === p.id).map((r) => r.kind),
      score:
        p.tags.reduce((s, t) => s + (weights[t] || 0), 0) +
        (peer.get(p.id) || 0) * 2 +
        1 / (1 + (Date.now() - new Date(p.created_at)) / 86400000),
      reason: peer.get(p.id)
        ? "与你收藏偏好相近的旅行者也喜欢"
        : p.tags.some((t) => weights[t])
          ? "与你的 " +
            p.tags
              .filter((t) => weights[t])
              .slice(0, 2)
              .join("、") +
            " 偏好相符"
          : "发现一种新的旅行方式",
    }))
    .sort((a, b) => b.score - a.score);
}
app.get("/api/posts", async (req, res) =>
  res.json(await recommended(req.user)),
);
app.get("/api/me/history", auth, async (req, res) =>
  res.json(
    (
      await query(
        "SELECT b.created_at,b.dwell_seconds,p.id,p.title,p.tags FROM browse_events b JOIN posts p ON b.post_id=p.id WHERE b.user_id=$1 AND p.hidden_at IS NULL ORDER BY b.created_at DESC LIMIT 100",
        [req.user.id],
      )
    ).rows,
  ),
);
const placeSchema = z.object({
  id: z.string().regex(/^[\w-]{1,80}$/),
  name: z.string().min(1).max(200),
  aliases: z.array(z.string().max(200)).max(30).optional(),
  category: z.enum([
    "city",
    "attraction",
    "hotel",
    "hostel",
    "rest",
    "station",
  ]),
  country: z.string().regex(/^[A-Z]{2}$/),
  province: z.string().max(100).optional(),
  city: z.string().min(1).max(100),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  timezone: z.string().max(100).optional(),
  tags: z.array(z.string().max(20)).max(20).optional(),
  description: z.string().max(2000).optional(),
  duration_min: z.number().int().min(0).max(1440).optional(),
  cost: z.number().min(0).max(1000000).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  hours: z
    .object({
      open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      lastEntry: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      closedWeekdays: z.array(z.number().int().min(0).max(6)),
      note: z.string().max(500).optional(),
    })
    .nullable()
    .optional(),
  source: z.string().min(1).max(200),
  license: z.string().min(1).max(200),
  source_url: z.url().optional(),
  verified_at: z.iso.datetime().nullable().optional(),
  data_status: z.enum(["demo", "reference", "verified"]),
});
app.post("/api/admin/places/import", auth, admin, async (req, res) => {
  const rows = z.array(placeSchema).min(1).max(500).parse(req.body);
  await transaction(async (c) => {
    for (const p of rows) await savePlace(p, c);
    await c.query("INSERT INTO import_jobs VALUES($1,$2,$3,$4,now())", [
      randomUUID(),
      "管理员导入",
      rows.length,
      "completed",
    ]);
    await c.query(
      "INSERT INTO audit_log(user_id,action,resource_id) VALUES($1,$2,$3)",
      [req.user.id, "places.import", String(rows.length)],
    );
  });
  res.json({ imported: rows.length });
});
app.use(
  "/vendor/leaflet",
  express.static(path.join(root, "node_modules/leaflet/dist"), {
    maxAge: "1d",
  }),
);
app.get('/amap-view.html',helmet.referrerPolicy({policy:'strict-origin-when-cross-origin'}),helmet.contentSecurityPolicy({directives:{
  defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-eval'",'https://webapi.amap.com','https://*.amap.com'],
  styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:','blob:','https://*.amap.com','https://*.autonavi.com'],
  connectSrc:["'self'",'https://*.amap.com','https://*.autonavi.com'],workerSrc:["'self'",'blob:'],
  upgradeInsecureRequests:production?[]:null,
}}),(req,res)=>res.sendFile(path.join(root,'public/amap-view.html')));
app.get('/google-view.html',helmet.contentSecurityPolicy({directives:{
  defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-eval'",'https://maps.googleapis.com','https://maps.gstatic.com','blob:'],
  styleSrc:["'self'","'unsafe-inline'",'https://fonts.googleapis.com'],fontSrc:["'self'",'https://fonts.gstatic.com'],
  imgSrc:["'self'",'data:','blob:','https://*.googleapis.com','https://*.gstatic.com','https://*.google.com','https://*.googleusercontent.com'],
  connectSrc:["'self'",'https://*.googleapis.com','https://*.gstatic.com','https://*.google.com','data:','blob:'],
  frameSrc:['https://*.google.com'],workerSrc:["'self'",'blob:'],upgradeInsecureRequests:production?[]:null,
}}),(req,res)=>res.sendFile(path.join(root,'public/google-view.html')));
app.get(["/legacy.html", "/catalog.html"], (req, res) => res.redirect(302, "/"));
app.use(express.static(path.join(root, "public"), { maxAge: 0 }));
app.use((err, req, res, next) => {
  operationEvents.systemError(req,err);
  if (err instanceof z.ZodError)
    return res
      .status(400)
      .json({
        error: "输入不符合要求",
        details: err.issues.map((x) => ({ path: x.path, message: x.message })),
      });
  if (err.code === "23503")
    return res.status(404).json({ error: "关联的记录不存在" });
  console.error('Request failed',req.operationRequestId||'unknown',err.status||500);
  res
    .status(err.status || 500)
    .json({
      error: err.status ? err.message : "服务器暂时无法处理请求，请稍后再试",
      ...(['catalog_busy','catalog_query_timeout','catalog_unavailable'].includes(err.code)?{code:err.code}:{}),
    });
});
if (process.env.SKIP_MIGRATIONS !== "true") await migrate();
if (
  process.env.REQUIRE_POSTGIS === "true" &&
  !(await query("SELECT 1 FROM pg_extension WHERE extname='postgis'")).rowCount
)
  throw new Error(
    "Production requires PostGIS; apply server/postgis.sql first",
  );
await seed();
await seedClassicWalks();
maintenance.start();
const exportCleanup=setInterval(()=>void logExports.cleanup().catch(()=>{}),3600000);exportCleanup.unref();
export const server = app.listen(
  Number(process.env.PORT || 8787),
  process.env.HOST || "127.0.0.1",
  () =>
    console.log(
      "SeaTraces ready: http://127.0.0.1:" + (process.env.PORT || 8787),
    ),
);
