/* 设置指定账号的后台管理员身份。 */

import 'dotenv/config';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
const [username,mode]=process.argv.slice(2);
if(!/^[a-zA-Z0-9_]{3,32}$/.test(username||'')||mode!=='--local')throw Error('Usage: node scripts/set-admin.mjs <existing-username> --local');
const c=JSON.parse(await readFile(new URL('../.runtime/local.json',import.meta.url),'utf8'));
const db=new pg.Client({host:'127.0.0.1',port:c.port,user:'seatraces',password:c.password,database:'seatraces'});
try{await db.connect();await db.query('BEGIN');const u=(await db.query('SELECT id,username,disabled_at FROM users WHERE lower(username)=$1 FOR UPDATE',[username.toLowerCase()])).rows[0];if(!u||u.disabled_at)throw Error('Existing active account required');await db.query("UPDATE users SET role='admin' WHERE id=$1",[u.id]);await db.query("INSERT INTO operation_events(user_id,kind,action,resource_id) VALUES($1,'admin','admin.bootstrap.local',$1)",[u.id]);await db.query('COMMIT');console.log(JSON.stringify({username:u.username,role:'admin',scope:'local-only'}));}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{await db.end();}
