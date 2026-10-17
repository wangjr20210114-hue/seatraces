import {createAdminActionRunner,prepareAdminAction} from '../operations/action-runner.mjs';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {query as dbQuery,transaction as dbTransaction} from '../db.mjs';
import {requireAdmin} from '../operations/routes.mjs';
import {catalogRequest,resolvePlace} from './catalog.mjs';
import {walkingRouter} from './citywalk-routing.mjs';
import {metres,walkName} from '../../public/citywalk-route.js';
const fail=(m,status=400)=>Object.assign(Error(m),{status});
const slug=z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/);
export async function seedClassicWalks(query=dbQuery){
  const items=JSON.parse(await readFile(new URL('../data/classic-citywalks.json',import.meta.url),'utf8'));
  for(const w of items){
    const params=[w.id,w.title,JSON.stringify(w.city),JSON.stringify(w.stops),JSON.stringify(w.sources),w.theme,w.motif,JSON.stringify(w.route),w.enabled];
    // Upgrade only the exact untouched legacy seed. Manual edits/visibility changes always win.
    const update=w.replaces?`DO UPDATE SET title=excluded.title,stops=excluded.stops,sources=excluded.sources,route=excluded.route,version=classic_citywalks.version+1,updated_at=now()
      WHERE classic_citywalks.updated_by IS NULL AND classic_citywalks.version=1 AND classic_citywalks.title=$10 AND classic_citywalks.stops=$11::jsonb AND classic_citywalks.sources=$12::jsonb AND classic_citywalks.enabled=$13`:'DO NOTHING';
    if(w.replaces)params.push(w.replaces.title,JSON.stringify(w.replaces.stops),JSON.stringify(w.replaces.sources),w.replaces.enabled);
    await query(`INSERT INTO classic_citywalks(id,title,city,stops,sources,theme,motif,route,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) ${update}`,params);
  }
}
export function installClassicWalkRoutes(app,{auth,events,query=dbQuery,transaction=dbTransaction,resolve=resolvePlace,search=catalogRequest,verify=walkingRouter.verify}){
  const runAction=createAdminActionRunner({transaction,events});
  app.get('/api/citywalk/classics',async(req,res)=>{
    const rows=(await query("SELECT id,title,city,stops,theme,motif,version,route->'distanceM' AS distance_m FROM classic_citywalks WHERE enabled ORDER BY city->>'name',id LIMIT 100")).rows;
    res.json({items:rows.map(w=>({...w,city:w.city.name,stops:w.stops.map(p=>p.name)}))});
  });
  app.get('/api/citywalk/classics/:id',async(req,res)=>{
    const row=(await query('SELECT id,title,city,stops,sources,theme,motif,route,version,updated_at FROM classic_citywalks WHERE id=$1 AND enabled',[slug.parse(req.params.id)])).rows[0];
    if(!row)throw fail('这条经典路线暂未开放',404);res.json(row);
  });
  app.get('/api/admin/citywalks',auth,requireAdmin,async(req,res)=>res.json({items:(await query('SELECT * FROM classic_citywalks ORDER BY updated_at DESC,id LIMIT 100')).rows}));
  app.get('/api/admin/citywalk/places',auth,requireAdmin,async(req,res)=>{
    const v=z.object({cityId:z.string().min(1).max(80),q:z.string().trim().min(2).max(80)}).parse(req.query);
    const city=(await query("SELECT * FROM places WHERE id=$1 AND category='city'",[v.cityId])).rows[0];if(!city)throw fail('城市不存在',404);
    const r=await search('/places',{q:v.q,lat:city.lat,lng:city.lng,radius:50000,limit:20});
    res.json({items:(r.items||[]).filter(p=>['attraction','heritage','nature','leisure','food','shopping'].includes(p.category)),status:r.status});
  });
  async function save(req,res){
    const updating=req.method==='PUT',key=updating?'classic.update':'classic.create';
    const {b}=prepareAdminAction(req,key);
    if(updating&&req.params.id!==b.id)throw fail('路线编号不一致');
    if(new Set(b.stopIds).size!==b.stopIds.length)throw fail('地点不能重复');
    const city=(await query("SELECT id,name,country,province,lat,lng,timezone FROM places WHERE id=$1 AND category='city'",[b.cityId])).rows[0];if(!city)throw fail('请选择已有城市',404);
    const stops=[];
    for(const id of b.stopIds){const p=await resolve(id);if(!p||!['attraction','heritage','nature','leisure','food','shopping'].includes(p.category)||!Number.isFinite(p.lat)||!Number.isFinite(p.lng)||metres(city,p)>80000)throw fail('地点不在可用步行范围');stops.push({...p,name:walkName(p),city:city.name,country:city.country});}
    const route=await verify(stops);
    if(b.enabled&&(route.status!=='verified'||route.blocked))throw fail(route.blocked?'路线达到 15 公里，不能发布':'步行路线暂未核验，可先存为未发布',422);
    const row=await runAction(req,key,async({c})=>{
      const old=(await c.query('SELECT * FROM classic_citywalks WHERE id=$1 FOR UPDATE',[b.id])).rows[0];
      if(updating&&(!old||old.version!==b.version))throw fail('路线已变化，请重新打开',409);
      if(!updating&&old)throw fail('路线编号已存在',409);
      const values=[b.id,b.title,JSON.stringify(city),JSON.stringify(stops),JSON.stringify(b.sources),b.theme,b.motif,JSON.stringify(route),b.enabled,req.user.id];
      const r=updating?await c.query('UPDATE classic_citywalks SET title=$2,city=$3,stops=$4,sources=$5,theme=$6,motif=$7,route=$8,enabled=$9,updated_by=$10,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',values):await c.query('INSERT INTO classic_citywalks(id,title,city,stops,sources,theme,motif,route,enabled,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING RETURNING *',values);
      if(!r.rowCount)throw fail('路线编号已存在',409);
      return {value:r.rows[0],metadata:{enabled:b.enabled,stops:stops.length}};
    });res.json(row);
  }
  app.post('/api/admin/citywalks',auth,requireAdmin,save);
  app.put('/api/admin/citywalks/:id',auth,requireAdmin,save);
  app.patch('/api/admin/citywalks/:id/visibility',auth,requireAdmin,async(req,res)=>{
    const row=await runAction(req,'classic.unpublish',async({c,b,id})=>{
      const r=await c.query('UPDATE classic_citywalks SET enabled=false,version=version+1,updated_at=now(),updated_by=$3 WHERE id=$1 AND version=$2 RETURNING *',[id,b.version,req.user.id]);
      if(!r.rowCount)throw fail('路线已变化',409);return {value:r.rows[0]};
    });res.json(row);
  });
}
