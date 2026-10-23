/* 验证后台登录和访问控制。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createFrontend} from '../server/frontend.mjs';
import {adminTokenHash} from '../server/operations/admin-access.mjs';
import {hashToken} from '../server/auth.mjs';
import {iterationFixture} from './helpers/iteration-db.mjs';

test('ADM-AUTH: independent management login, protected document and session boundaries', {skip:process.env.TEST_OPERATIONS!=='1'},async t=>{
  const f=await iterationFixture({production:true});let frontend;
  try{
    const port=await f.start();
    frontend=http.createServer(createFrontend({backendOrigin:'http://127.0.0.1:'+port}));
    await new Promise(r=>frontend.listen(0,'127.0.0.1',r));
    const base='http://127.0.0.1:'+frontend.address().port;
    const request=(path,cookie='',body,extra={})=>fetch(base+path,{redirect:'manual',method:body?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json','X-Seatraces':'1',...extra},...(body?{body:JSON.stringify(body)}:{})});
    const login=(username=f.users.admin.username,password=f.password,cookie='')=>request('/api/auth/admin/login',cookie,{username,password});
    let adminCookie;
    await t.test('01 anonymous HTML redirects before rendering; encoded/static aliases reveal no dashboard',async()=>{
      for(const path of ['/admin','/admin.html','/ADMIN.HTML','/admin.html?view=users']){
        const r=await request(path);assert.equal(r.status,302,path);assert.equal(r.headers.get('location'),'/admin-login.html');assert.match(r.headers.get('cache-control'),/no-store/);
        assert.ok(!(await r.text()).includes('id="admin-content"'));
      }
      for(const path of ['/%61dmin.html','/admin.html/','/admin.html.','/server/operations/admin.html']){
        const r=await request(path);assert.notEqual(r.status,200,path);assert.ok(!(await r.text()).includes('id="admin-content"'));
      }
      assert.equal((await request('/admin-login.html')).status,200);
      for(const path of ['/api/admin/users','/api/admin/events/export','/api/admin/future-endpoint'])assert.equal((await request(path)).status,401);
      assert.equal((await request('/api/admin/places/import','',{places:[]})).status,401);
    });
    await t.test('02 ordinary user and ordinary administrator app sessions cannot enter management',async()=>{
      assert.equal((await request('/api/admin/users',f.users.user.cookie)).status,403);
      assert.equal((await request('/api/admin/users',f.users.admin.appCookie)).status,401);
      assert.equal((await request('/admin.html',f.users.admin.appCookie)).status,302);
      assert.equal((await (await request('/api/auth/admin/me',f.users.admin.appCookie)).json()).user,null);
      const token=f.users.admin.appCookie.split('=')[1];
      assert.equal((await request('/api/admin/users','st_admin='+token)).status,401,'renaming the app cookie cannot elevate it');
      assert.equal((await login(f.users.user.username)).status,401);
      assert.equal((await login('unknown_admin')).status,401);
      assert.equal((await login(undefined,'wrong-password')).status,401);
    });
    await t.test('03 password login creates a hashed, secure, short management session; rotates old session',async()=>{
      let r=await login();assert.equal(r.status,200);const raw=r.headers.get('set-cookie');
      for(const flag of [/HttpOnly/,/Secure/,/SameSite=Strict/,/Max-Age=1800/])assert.match(raw,flag);
      adminCookie=raw.split(';')[0];const data=await r.json();
      assert.ok(new Date(data.expiresAt)-Date.now()>1790000);assert.ok(new Date(data.expiresAt)-Date.now()<=1800000);
      assert.deepEqual(Object.keys(data.user).sort(),['id','nickname','role','username']);
      const token=adminCookie.split('=')[1];assert.notEqual(adminTokenHash(token),hashToken(token));
      assert.equal((await f.query('SELECT 1 FROM sessions WHERE token_hash=$1',[token])).rowCount,0);
      assert.equal((await f.query('SELECT 1 FROM sessions WHERE token_hash=$1',[adminTokenHash(token)])).rowCount,1);
      assert.equal((await request('/api/admin/users',adminCookie)).status,200);
      r=await request('/admin.html',adminCookie);assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-store/);assert.ok((await r.text()).includes('id="admin-logout"'));
      assert.equal((await (await request('/api/me','st_session='+token)).json()).user,null,'admin token cannot become an application cookie');
      const old=adminCookie;r=await login(undefined,undefined,old);adminCookie=r.headers.get('set-cookie').split(';')[0];
      assert.equal((await request('/api/admin/users',old)).status,401);
    });
    await t.test('04 CSRF attempts, forged role and revoked/expired tokens are denied',async()=>{
      assert.equal((await request('/api/auth/admin/logout',adminCookie,{}, {'X-Seatraces':''})).status,403);
      assert.equal((await request('/api/auth/admin/logout',adminCookie,{}, {'Sec-Fetch-Site':'cross-site'})).status,403);
      assert.equal((await request('/api/admin/users','st_admin='+randomBytes(32).toString('hex'),undefined,{'X-Role':'admin'})).status,401);
      await f.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[adminTokenHash(adminCookie.split('=')[1])]);
      assert.equal((await request('/api/admin/users',adminCookie)).status,401);
      assert.equal((await request('/admin.html',adminCookie)).status,302);
      adminCookie=(await login()).headers.get('set-cookie').split(';')[0];
      await f.query('UPDATE users SET disabled_at=now() WHERE id=$1',[f.users.admin.id]);
      assert.equal((await request('/api/admin/users',adminCookie)).status,401);
      await f.query("UPDATE users SET disabled_at=NULL,role='user' WHERE id=$1",[f.users.admin.id]);
      assert.equal((await request('/api/admin/users',adminCookie)).status,401);
      await f.query("UPDATE users SET role='admin' WHERE id=$1",[f.users.admin.id]);
    });
    await t.test('05 logout invalidates server session but preserves app login',async()=>{
      adminCookie=(await login()).headers.get('set-cookie').split(';')[0];
      const both=f.users.admin.appCookie+'; '+adminCookie;
      assert.equal((await request('/api/auth/admin/logout',both,{})).status,200);
      assert.equal((await request('/api/admin/users',adminCookie)).status,401);
      assert.equal((await (await request('/api/me',f.users.admin.appCookie)).json()).user.username,f.users.admin.username);
    });
    await t.test('06 shared account rate limit prevents bypass through app login',async()=>{
      await f.query("INSERT INTO auth_rate_limits(key_hash,hits,until) VALUES($1,10,now()+interval '10 minutes') ON CONFLICT(key_hash) DO UPDATE SET hits=10,until=excluded.until",[hashToken('login:'+f.users.admin.username)]);
      assert.equal((await login()).status,429);
      assert.equal((await request('/api/auth/login','',{username:f.users.admin.username,password:f.password})).status,429);
      await f.query('DELETE FROM auth_rate_limits WHERE key_hash=$1',[hashToken('login:'+f.users.admin.username)]);
    });
    await t.test('07 concurrent mixed sessions do not share privileges (200 requests, concurrency 10)',async()=>{
      adminCookie=(await login()).headers.get('set-cookie').split(';')[0];
      let cursor=0;
      const actors=[['',401],[f.users.user.cookie,403],[f.users.admin.appCookie,401],[adminCookie,200]];
      await Promise.all(Array.from({length:10},async()=>{while(cursor<200){const i=cursor++,[cookie,status]=actors[i%actors.length];assert.equal((await request('/api/admin/users',cookie)).status,status);}}));
    });
    await t.test('08 classic editor city search works with management session alone',async()=>{
      await f.query("CREATE TABLE places(id text,name text,category text,province text,country text); INSERT INTO places VALUES('city','上海','city','上海','CN')");
      const r=await request('/api/admin/cities?q='+encodeURIComponent('上海'),adminCookie);assert.equal(r.status,200);assert.equal((await r.json())[0].id,'city');
    });
    await t.test('09 backend outage never exposes protected HTML',async()=>{
      const dead=http.createServer();await new Promise(r=>dead.listen(0,'127.0.0.1',r));const port=dead.address().port;await new Promise(r=>dead.close(r));
      const isolated=http.createServer(createFrontend({backendOrigin:'http://127.0.0.1:'+port,proxyTimeoutMs:100}));await new Promise(r=>isolated.listen(0,'127.0.0.1',r));
      try{const b='http://127.0.0.1:'+isolated.address().port;assert.equal((await fetch(b+'/admin.html')).status,503);assert.equal((await fetch(b+'/admin-login.html')).status,200);assert.equal((await fetch(b+'/')).status,200);}
      finally{isolated.closeAllConnections();await new Promise(r=>isolated.close(r));}
    });
  }finally{if(frontend){frontend.closeAllConnections();await new Promise(r=>frontend.close(r));}await f.close();}
});

test('admin document is absent from public static tree',async()=>{
  await assert.rejects(readFile(new URL('../public/admin.html',import.meta.url)),{code:'ENOENT'});
});
