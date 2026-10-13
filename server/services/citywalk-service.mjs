import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query as dbQuery } from '../db.mjs';
import { citySelectionForUser } from './journey-service.mjs';
import { createReadJobs } from './read-jobs.mjs';
import { orderWalk, routeMetres, walkName } from '../../public/citywalk-route.js';

const error = (message, status = 400) => Object.assign(Error(message), { status });
const inputSchema = z.object({
  id: z.uuid(), draftId: z.uuid(), title: z.string().trim().min(1).max(80),
  clusterIds: z.array(z.string().min(1).max(200)).min(1).max(50),
  stopIds: z.array(z.string().min(1).max(200)).min(2).max(100),
  startId: z.string().min(1).max(200), version: z.number().int().min(1).optional(),
}).strict();
export function selectedWalk(draft, input, previous) {
  if (new Set(input.stopIds).size !== input.stopIds.length || new Set(input.clusterIds).size !== input.clusterIds.length) throw error('景点或片区不能重复');
  const groups = input.clusterIds.map(id => draft.catalog.clusters.find(g => g.id === id));
  if (groups.some(g => !g)) throw error('片区已变化，请重新选择');
  const candidates = new Map(groups.flatMap(g => g.members).map(p => [p.id, p]));
  // Keep previously saved source snapshots editable when the live catalog has changed.
  if (previous?.city.id === draft.city.id) for (const p of previous.stops) if (!candidates.has(p.id)) candidates.set(p.id, p);
  const stops = input.stopIds.map(id => candidates.get(id));
  if (stops.some(p => !p) || !input.stopIds.includes(input.startId)) throw error('请选择当前片区中的景点');
  return orderWalk(stops, input.startId).map(p => ({
    id: p.id, name: walkName(p), aliases: [...new Set([p.name, ...(p.aliases || [])])].filter(n => n !== walkName(p)), category: p.category,
    lat: p.lat, lng: p.lng, coord_system: 'WGS84', country: p.country || draft.city.country,
    mainlandCityVerified: p.mainlandCityVerified, city: draft.city.name,
    source: p.source, source_url: p.source_url, license: p.license,
  }));
}

export function installCityWalkRoutes(app, { auth, travelHabit, query = dbQuery, loadCity = citySelectionForUser }) {
  const job = createReadJobs();
  const own = async (id, user) => {
    z.uuid().parse(id);
    const row = (await query('SELECT * FROM citywalks WHERE id=$1 AND user_id=$2', [id, user])).rows[0];
    if (!row) throw error('这条 CityWalk 不存在', 404);
    return row;
  };
  app.get('/api/citywalk/catalog/:cityId', auth, async (req, res) => {
    const cityId = z.string().min(1).max(80).parse(req.params.cityId);
    const result = job(req.user.id + ':' + cityId, async () => {
      const city = (await query("SELECT id,name,country,province,lat,lng,timezone FROM places WHERE id=$1 AND category='city'", [cityId])).rows[0];
      if (!city) throw error('请从列表选择城市', 404);
      const data = await loadCity(city, req.user, travelHabit), draftId = randomUUID();
      await query('DELETE FROM citywalk_drafts WHERE expires_at < now()');
      await query('INSERT INTO citywalk_drafts(id,user_id,city,catalog) VALUES($1,$2,$3,$4)', [draftId, req.user.id, JSON.stringify(city), JSON.stringify({ clusters: data.clusters })]);
      return { ...data, draftId };
    });
    res.status(result.status === 'loading' ? 202 : 200).json(result);
  });
  app.get('/api/citywalks', auth, async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(50).parse(req.query.limit || 10);
    const offset = z.coerce.number().int().min(0).parse(req.query.offset || 0);
    const rows = (await query(`SELECT id,title,city,stops,distance_m,version,updated_at FROM citywalks WHERE user_id=$1 ORDER BY updated_at DESC,id LIMIT $2 OFFSET $3`, [req.user.id, limit, offset])).rows;
    res.json(rows.map(r => ({ ...r, stops: r.stops.map(p => ({ id: p.id, name: p.name })) })));
  });
  app.get('/api/citywalks/:id', auth, async (req, res) => res.json(await own(req.params.id, req.user.id)));
  async function save(req, res) {
    const input = inputSchema.parse(req.body), updating = req.method === 'PUT';
    if (updating && req.params.id !== input.id) throw error('路线编号不一致');
    const previous = updating ? await own(input.id, req.user.id) : null;
    const draft = (await query('SELECT * FROM citywalk_drafts WHERE id=$1 AND user_id=$2 AND expires_at>now()', [input.draftId, req.user.id])).rows[0];
    if (!draft) throw error('景点列表已过期，请重新打开编辑页', 410);
    const stops = selectedWalk(draft, input, previous), distance = Math.round(routeMetres(stops));
    let result;
    if (updating) {
      if (!input.version) throw error('缺少路线版本');
      result = await query(`UPDATE citywalks SET title=$3,city=$4,stops=$5,cluster_ids=$6,distance_m=$7,version=version+1,updated_at=now() WHERE id=$1 AND user_id=$2 AND version=$8 RETURNING *`, [input.id, req.user.id, input.title, JSON.stringify(draft.city), JSON.stringify(stops), input.clusterIds, distance, input.version]);
      if (!result.rowCount) throw error('路线已在其他页面修改，请重新打开后编辑', 409);
    } else {
      result = await query(`INSERT INTO citywalks(id,user_id,title,city,stops,cluster_ids,distance_m) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING *`, [input.id, req.user.id, input.title, JSON.stringify(draft.city), JSON.stringify(stops), input.clusterIds, distance]);
      // A retry after a lost response returns the original, without another route.
      if (!result.rowCount) return res.json(await own(input.id, req.user.id));
    }
    res.json(result.rows[0]);
  }
  app.post('/api/citywalks', auth, save);
  app.put('/api/citywalks/:id', auth, save);
}
