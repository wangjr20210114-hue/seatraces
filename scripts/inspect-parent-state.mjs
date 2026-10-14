import {readFile} from 'node:fs/promises';
import dotenv from 'dotenv';
const root=new URL('../',import.meta.url);dotenv.config({path:new URL('.env',root),quiet:true});
const local=JSON.parse(await readFile(new URL('.runtime/local.json',root),'utf8'));
process.env.DATABASE_URL=`postgresql://seatraces:${encodeURIComponent(local.password)}@127.0.0.1:${local.port}/seatraces`;
const {query,pool}=await import('../server/db.mjs');
const {parentInputHash}=await import('../server/domain/amap-parent.mjs');
try {
  const cities=(await query("SELECT id,name,country FROM places WHERE category='city' AND name=ANY($1)",[['北京','上海','广州','深圳','杭州']])).rows;
  console.log(JSON.stringify({cities}));
  console.log(JSON.stringify({outcomes:(await query("SELECT result->>'status' status,count(*)::int n FROM scenic_parent_checks GROUP BY 1")).rows,
    reserved:(await query("SELECT provider,count(*)::int calls,sum(reserved_cny)::float8 reserved FROM api_usage WHERE created_at>=date_trunc('month',now()) GROUP BY provider")).rows}));
  const pilot=JSON.parse(await readFile(new URL('.runtime/palace-evidence-20261012/catalog.json',root),'utf8'));
  const cache=JSON.parse(await readFile(new URL('.runtime/catalog-cache.json',root),'utf8'));
  for (const id of ['osm:way/638449347','osm:relation/8854349']) {
    const row=(await query('SELECT input_hash,result FROM scenic_parent_checks WHERE place_id=$1',[id])).rows[0];
    const p=pilot.items.find(p=>p.id===id);
    const cached=Object.values(cache).flatMap(v=>v.payload?.items || []).filter(p=>p.id===id);
    const fields=p=>p?{name:p.name,lat:p.lat,lng:p.lng,country:p.country,region:p.region,extract_region:p.extract_region}:null;
    console.log(JSON.stringify({id,stored:row,pilot:fields(p),cityVersions:cached.map(p=>({point:fields(p),matches:parentInputHash({...p,country:'CN'})===row?.input_hash})).slice(0,8)}));
  }
} finally {await pool.end();}
