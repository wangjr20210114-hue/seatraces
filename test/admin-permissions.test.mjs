/* 验证后台角色权限。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {managementAccess,routePermission,can} from '../server/operations/permissions.mjs';
import {iterationFixture} from './helpers/iteration-db.mjs';

test('management policy is explicit and unknown routes fail closed',()=>{
  assert.equal(routePermission('GET','/events/export'),'events.export');
  assert.equal(routePermission('DELETE','/users/123'),null);
  assert.equal(routePermission('GET','/future-endpoint'),null);
  assert.equal(routePermission('HEAD','/overview'),'overview.read');
  assert.equal(managementAccess({username:'demo_12345678',role:'admin'}),null);
  assert.equal(managementAccess({username:'normal',role:'user'}),null);
  const access=managementAccess({role:'user',management_role:'support',management_enabled:true,management_version:2});
  assert.ok(can(access,'users.read'));assert.equal(can(access,'users.manage'),false);
});

test('RBAC role assignments, session revocation, field restrictions and concurrent access', {skip:process.env.TEST_OPERATIONS!=='1'},async t=>{
  const f=await iterationFixture();
  try{
    await f.start();let staffCookie='',version=0;
    const endpoint='/api/admin/access/members/'+f.users.user.id;
    const assign=async role=>{
      const r=await f.request(endpoint,{method:'PUT',body:{role,version,confirmation:'change-role'}});
      assert.equal(r.status,200,JSON.stringify(r.data));version=r.data.version;return r;
    };
    const staff=(path,options={})=>f.request(path,{...options,user:null,headers:{Cookie:staffCookie,...options.headers}});
    const login=async()=>{
      const r=await f.request('/api/auth/admin/login',{user:null,body:{username:f.users.user.username,password:f.password}});
      assert.equal(r.status,200);staffCookie=r.headers.get('set-cookie').split(';')[0];return staffCookie;
    };
    await t.test('RBAC01 ordinary app users never inherit management privileges',async()=>{
      assert.equal((await f.request('/api/admin/access',{user:'user'})).status,403);
      await assign('analyst');
      assert.equal((await f.request('/api/admin/access',{user:'user'})).status,403);
      await login();
      const me=await staff('/api/auth/admin/me');assert.equal(me.data.access.role,'analyst');assert.equal(me.data.user.role,'user');
      assert.equal((await staff('/api/admin/users')).status,403);
      assert.equal((await staff('/api/admin/events/export')).status,403);
      const overview=await staff('/api/admin/overview');assert.equal(overview.status,200);assert.equal(overview.data.health,undefined);
      assert.equal((await staff('/api/admin/future-endpoint')).status,403);
      assert.equal((await f.request('/api/admin/future-endpoint')).status,403);
    });
    await t.test('RBAC02 role change requires owner, confirmation, current version; audit is atomic',async()=>{
      const b={role:'operator',version,confirmation:'change-role'};
      assert.equal((await staff(endpoint,{method:'PUT',body:b})).status,403);
      assert.equal((await f.request(endpoint,{method:'PUT',body:{role:'operator',version}})).status,400);
      assert.equal((await f.request(endpoint,{method:'PUT',body:{...b,version:0}})).status,409);
      assert.equal((await f.request(endpoint,{method:'PUT',body:{...b,role:'administrator'}})).status,400);
      assert.equal((await f.request('/api/admin/access/members/'+f.users.admin.id,{method:'PUT',body:b})).status,409);
      const before=await f.query("SELECT count(*)::int n FROM operation_events WHERE action='management.role_changed'");
      const results=await Promise.all(Array.from({length:10},()=>f.request(endpoint,{method:'PUT',body:b})));
      assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,9);
      version=results.find(r=>r.status===200).data.version;
      assert.equal((await f.query("SELECT count(*)::int n FROM operation_events WHERE action='management.role_changed'")).rows[0].n,before.rows[0].n+1);
      assert.equal((await staff('/api/admin/overview')).status,401);
      assert.equal((await f.request('/api/me',{user:'user'})).data.user.id,f.users.user.id);
    });
    await t.test('RBAC03 operators can list recipients but cannot inspect private activity or grant permissions',async()=>{
      await login();assert.equal((await staff('/api/admin/users')).status,200);
      for(const path of ['/api/admin/users/'+f.users.other.id,'/api/admin/events','/api/admin/access/members','/api/admin/tasks'])assert.equal((await staff(path)).status,403,path);
      assert.equal((await staff('/api/admin/users/'+f.users.other.id+'/status',{method:'PATCH',body:{disabled:true,reason:'support'}})).status,403);
    });
    await t.test('RBAC04 revocation cannot resurrect old cookies after regrant; support cannot export or mutate',async()=>{
      const old=staffCookie;await assign(null);
      assert.equal((await staff('/api/auth/admin/me')).data.user,null);
      assert.equal((await f.request('/api/auth/admin/login',{user:null,body:{username:f.users.user.username,password:f.password}})).status,401);
      await assign('support');staffCookie=old;assert.equal((await staff('/api/admin/users')).status,401);
      await login();assert.equal((await staff('/api/admin/users/'+f.users.other.id)).status,200);
      assert.equal((await staff('/api/admin/events')).status,200);assert.equal((await staff('/api/admin/events/export')).status,403);
      assert.equal((await staff('/api/admin/users/'+f.users.other.id+'/sessions/revoke',{body:{confirmation:'revoke',reason:'support'}})).status,403);
      await f.query('UPDATE users SET disabled_at=now() WHERE id=$1',[f.users.user.id]);
      assert.equal((await staff('/api/admin/users')).status,401);
      assert.equal((await f.request(endpoint,{method:'PUT',body:{role:'support',version,confirmation:'change-role'}})).status,409);
      await f.query('UPDATE users SET disabled_at=NULL WHERE id=$1',[f.users.user.id]);
    });
    await t.test('RBAC05 240 mixed authorized/forbidden requests, concurrency 12',async()=>{
      await login();let index=0;const tasks=[['/api/admin/users',200],['/api/admin/events/export',403],['/api/admin/access/members',403],['/api/admin/overview',200]];
      await Promise.all(Array.from({length:12},async()=>{while(index<240){const [path,status]=tasks[index++%tasks.length];assert.equal((await staff(path)).status,status);}}));
      const exported=JSON.stringify((await f.request('/api/admin/access/members')).data);
      for(const secret of ['password_hash','token_hash','st_admin','admin_access_version'])assert.equal(exported.includes(secret),false);
    });
  }finally{await f.close();}
});
