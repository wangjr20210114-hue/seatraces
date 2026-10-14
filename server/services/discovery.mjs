import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query as dbQuery } from '../db.mjs';

export function publicRoute(kind, route) {
  const days = kind === 'citywalk' ? [{ city: route.city.name, stops: route.stops }] : route.plan.days;
  return {
    kind,
    cities: kind === 'citywalk' ? [route.city.name] : route.plan.cities.map(c => c.name),
    ...(kind === 'citywalk' ? { distance_m: route.distance_m } : {}),
    days: days.map(day => ({ city: day.city, stops: (day.stops || []).map(p => ({
      id: p.id, name: p.name, lat: p.lat, lng: p.lng, category: p.category,
      source_url: p.source_url, license: p.license,
    })) })),
  };
}

export function installDiscoveryRoutes(app, { auth, query = dbQuery }) {
  app.post('/api/discovery/publish', auth, async (req, res) => {
    const { kind, id } = z.object({ kind: z.enum(['journey','citywalk']), id: z.uuid() }).strict().parse(req.body);
    const table = kind === 'citywalk' ? 'citywalks' : 'trips';
    const route = (await query(`SELECT * FROM ${table} WHERE id=$1 AND user_id=$2`, [id, req.user.id])).rows[0];
    if (!route) return res.status(404).json({error:'路线不存在'});
    const snapshot = publicRoute(kind, route);
    const column = kind === 'citywalk' ? 'citywalk_id' : 'trip_id';
    const conflict = kind === 'citywalk' ? 'citywalk_id' : 'user_id,trip_id';
    const post = (await query(`INSERT INTO posts(id,user_id,${column},title,body,tags,snapshot,auto_shared)
      VALUES($1,$2,$3,$4,$5,$6,$7,false)
      ON CONFLICT(${conflict}) DO UPDATE SET snapshot=excluded.snapshot,auto_shared=false
      RETURNING *`, [randomUUID(),req.user.id,id,route.title.slice(0,100),
      kind === 'citywalk' ? `${route.stops.length} 个景点，串成一条 CityWalk。` : `${snapshot.days.length} 天路线，看看沿途有哪些好风景。`,
      kind === 'citywalk' ? ['CityWalk'] : route.request.interests || [], JSON.stringify(snapshot)])).rows[0];
    res.json(post);
  });
  app.get('/api/discovery/mine', auth, async (req, res) => {
    const { limit, offset } = z.object({limit:z.coerce.number().int().min(1).max(50).default(12),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).parse(req.query);
    const rows = (await query(`SELECT p.*,u.nickname,u.avatar,true AS "isOwn" FROM posts p JOIN users u ON u.id=p.user_id
      WHERE p.user_id=$1 AND NOT p.auto_shared ORDER BY p.created_at DESC,p.id DESC LIMIT $2 OFFSET $3`,[req.user.id,limit+1,offset])).rows;
    res.json({items:rows.slice(0,limit),hasMore:rows.length>limit});
  });
}
