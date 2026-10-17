import pg from 'pg';
import {readFile} from 'node:fs/promises';
export async function localDatabase(){
 if(!process.argv.includes('--local')||process.env.NODE_ENV==='production')throw Error('This command requires --local and cannot target production');
 const cfg=JSON.parse(await readFile(new URL('../.runtime/local.json',import.meta.url),'utf8'));
 const pool=new pg.Pool({host:'127.0.0.1',port:cfg.port,user:'seatraces',password:cfg.password,database:'seatraces',max:3,statement_timeout:60000});
 const query=(s,v)=>pool.query(s,v),transaction=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 await query('SELECT 1');return {query,transaction,close:()=>pool.end()};
}
