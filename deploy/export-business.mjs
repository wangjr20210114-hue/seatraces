// First server migration only. Output contains private application records;
// keep it outside Git and transmit only to the application's own server.
import pg from 'pg';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.runtime/backend-deploy');
await mkdir(output, { recursive: true, mode: 0o700 });
const local = process.env.DATABASE_URL ? null : JSON.parse(await readFile(path.join(root,'.runtime/local.json'),'utf8'));
const client = new pg.Client(process.env.DATABASE_URL ? { connectionString:process.env.DATABASE_URL } : {
  host:'127.0.0.1',port:local.port,user:'seatraces',password:local.password,database:'seatraces',
});
const ident = s => '"'+s.replaceAll('"','""')+'"';
const literal = s => "'"+s.replaceAll("'","''")+"'";
const text = s => s === null ? '\\N' : s.replaceAll('\\','\\\\').replaceAll('\t','\\t').replaceAll('\n','\\n').replaceAll('\r','\\r');
const skipped = new Set(['sessions','account_tokens','auth_rate_limits']);
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const schemas = await Promise.all(['schema.sql','auth-schema.sql','citywalk-schema.sql'].map(f=>readFile(path.join(root,'server',f),'utf8')));
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename);
  const known = new Set([...schemas.join('\n').matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)].map(m=>m[1]));
  if (tables.some(t=>!known.has(t))) throw Error('Unrecognized table: review the migration schema before export');
  const edges = (await client.query(`SELECT c.relname child,p.relname parent FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid JOIN pg_class p ON p.oid=fk.confrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE fk.contype='f' AND n.nspname='public'`)).rows;
  const ordered=[],remaining=new Set(tables);
  while(remaining.size) {
    const next=[...remaining].filter(t=>!edges.some(e=>e.child===t && e.parent!==t && remaining.has(e.parent)));
    if(!next.length) throw Error('Cyclic foreign keys require an explicit migration');
    ordered.push(...next);next.forEach(t=>remaining.delete(t));
  }
  const sql=['\\set ON_ERROR_STOP on','BEGIN;',...schemas],counts={};
  for(const table of ordered) {
    const columns=(await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`,[table])).rows.map(r=>r.column_name);
    if(skipped.has(table)){counts[table]=0;continue;}
    const rows=(await client.query('SELECT '+columns.map(c=>ident(c)+'::text AS '+ident(c)).join(',')+' FROM public.'+ident(table))).rows;
    counts[table]=rows.length;
    if(rows.length) sql.push('COPY public.'+ident(table)+' ('+columns.map(ident).join(',')+') FROM stdin;',...rows.map(r=>columns.map(c=>text(r[c])).join('\t')),'\\.');
    for(const column of columns){
      const sequence=(await client.query('SELECT pg_get_serial_sequence($1,$2) value',['public.'+ident(table),column])).rows[0].value;
      if(sequence) sql.push(`SELECT setval(${literal(sequence)}, COALESCE((SELECT max(${ident(column)}) FROM public.${ident(table)}),1), EXISTS(SELECT 1 FROM public.${ident(table)}));`);
    }
  }
  sql.push('COMMIT;');
  const raw=sql.join('\n')+'\n';
  await writeFile(path.join(output,'business.sql'),raw,{mode:0o600});
  const manifest={createdAt:new Date().toISOString(),counts,skipped:[...skipped],bytes:Buffer.byteLength(raw),sha256:createHash('sha256').update(raw).digest('hex')};
  await writeFile(path.join(output,'business-manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  await client.query('COMMIT');
  console.log(JSON.stringify(manifest));
} finally {await client.end();}
