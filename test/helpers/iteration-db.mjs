import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import cookieParser from 'cookie-parser';
import {createAccounts,hashToken,requireUser} from '../../server/auth.mjs';
import {createEventRecorder} from '../../server/operations/events.mjs';
import {installOperationsRoutes} from '../../server/operations/routes.mjs';
import {installAdminAccess,adminTokenHash} from '../../server/operations/admin-access.mjs';
import {installAccessRoutes} from '../../server/operations/access-routes.mjs';
import {requestContext,applyRequestContext,trackedMutation,withRequestContext} from '../../server/operations/request-context.mjs';

export async function iterationFixture({schemas=[],production=false}={}) {
  const cfg=JSON.parse(await readFile(process.env.ITERATION_DB_CONFIG || new URL('../../.runtime/local.json',import.meta.url),'utf8'));
  const schema='iteration_'+randomBytes(8).toString('hex');
  // Leave headroom in the local 30-connection database for the running app and
  // browser preview when several isolated suites execute concurrently.
  const pool=new pg.Pool({host:'127.0.0.1',port:cfg.port,user:'seatraces',password:cfg.password,database:'seatraces',max:4,connectionTimeoutMillis:5000,options:`-c search_path=${schema},public`});
  const query=(sql,values)=>requestContext()&&trackedMutation(sql)?transaction(c=>c.query(sql,values)):pool.query(sql,values);
  const transaction=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');await applyRequestContext(c);const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
  let server,events,created=false;
  async function close(){await new Promise(resolve=>server?server.close(resolve):resolve());await events?.close();try{if(created)await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await pool.end();}}
  try{
    // Local hot reload may restart embedded PostgreSQL between source edits and tests.
    // Wait for readiness, but never swallow a database failure or skip a test.
    for(let i=0;;i++){try{await query('SELECT 1');break;}catch(e){if(i>=19||!['57P03','ECONNREFUSED','ECONNRESET'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,500));}}
    await query(`CREATE SCHEMA ${schema}`);
    created=true;
    // Minimal isolated accounts; no dependency on or access to real users.
    await query(`CREATE TABLE users(id uuid PRIMARY KEY,username varchar(32) UNIQUE NOT NULL,password_hash text NOT NULL,nickname varchar(40) NOT NULL,avatar varchar(12) NOT NULL DEFAULT '🌊',role text NOT NULL DEFAULT 'user',preferences jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE sessions(token_hash text PRIMARY KEY,user_id uuid REFERENCES users(id) ON DELETE CASCADE,expires_at timestamptz);
      CREATE TABLE import_jobs(id uuid PRIMARY KEY,source text,rows_count integer,status text,created_at timestamptz DEFAULT now());`);
    for(const file of ['auth-schema.sql','operations/schema.sql','operations/access-schema.sql','operations/log-views-schema.sql',...schemas])await query(await readFile(new URL('../../server/'+file,import.meta.url),'utf8'));
    events=createEventRecorder({query,intervalMs:60000});
    const accounts=createAccounts({query,transaction});
    const app=express();app.use(express.json(),cookieParser());
    app.use('/api',(req,res,next)=>!['GET','HEAD'].includes(req.method)&&req.get('X-Seatraces')!=='1'?res.status(403).json({error:'source'}):next());
    app.use('/api',accounts.attach,events.middleware);
    installAdminAccess(app,{query,transaction,production});
    app.use('/api',accounts.gate,accounts.router);
    app.use('/api',withRequestContext);
    installOperationsRoutes(app,{auth:requireUser,query,transaction,events});
    installAccessRoutes(app,{query,transaction,events});
    const users={};
    const password='Iteration-fixture-Password!';
    const digest=await bcrypt.hash(password,4);
    for(const [name,role] of [['admin','admin'],['user','user'],['other','user']]){
      const id=randomUUID(),token=randomBytes(32).toString('hex');
      await query('INSERT INTO users(id,username,password_hash,nickname,role) VALUES($1,$2,$3,$2,$4)',[id,'fixture_'+name,digest,role]);
      await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),id]);
      const appCookie='st_session='+token;
      let cookie=appCookie;
      if(role==='admin'){
        const adminToken=randomBytes(32).toString('hex');
        await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')",[adminTokenHash(adminToken),id]);
        cookie+='; st_admin='+adminToken;
      }
      users[name]={id,username:'fixture_'+name,cookie,appCookie};
    }
    return {app,users,password,query,transaction,events,auth:requireUser,schema,
      async start(){app.use((err,req,res,next)=>{events.systemError(req,err);res.status(err.status||(err.name==='ZodError'?400:500)).json({error:err.status?err.message:err.name==='ZodError'?'invalid':'internal'});});
        // This Windows host may allocate low ephemeral ports. Reject only the
        // Fetch blocklist instead of excluding the host's entire ephemeral range.
        const blocked=new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,5060,5061,6000,6566,6665,6666,6667,6668,6669,6697,10080]);
        for(let attempt=0;attempt<10;attempt++){
          server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
          const port=server.address().port;if(!blocked.has(port))return port;
          await new Promise(resolve=>server.close(resolve));server=null;
        }
        throw Error('Could not allocate a Fetch-compatible local test port');
      },
      async request(path,{user='admin',body,method,headers={}}={}){
        const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Seatraces':'1',...(user?{Cookie:users[user].cookie}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
        const data=r.headers.get('content-type')?.includes('json')?await r.json():Buffer.from(await r.arrayBuffer());return {status:r.status,data,headers:r.headers};
      },close};
  }catch(e){await close();throw e;}
}
