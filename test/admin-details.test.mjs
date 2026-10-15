import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
test('admin account/session/log details enforce bounds and authorization',{skip:process.env.TEST_OPERATIONS!=='1'},async t=>{
  const f=await iterationFixture();
  try{
    await f.start();
    const userPath='/api/admin/users/'+f.users.user.id;
    await t.test('filter states and roles; details expose no credentials or email addresses',async()=>{
      assert.equal((await f.request('/api/admin/users?role=admin')).data.items.length,1);
      assert.equal((await f.request('/api/admin/users?state=disabled')).data.items.length,0);
      assert.equal((await f.request('/api/admin/users?role=root')).status,400);
      await f.query('INSERT INTO user_emails(user_id,email) VALUES($1,$2)',[f.users.user.id,'private@example.test']);
      for(const actor of [null,'user','other'])assert.equal((await f.request(userPath,{user:actor})).status,actor?403:401);
      const r=await f.request(userPath);assert.equal(r.status,200);assert.equal(r.data.user.email_verified,true);assert.equal(r.data.sessions.length,1);
      const json=JSON.stringify(r.data);for(const secret of ['token_hash','password_hash','private@example.test',f.users.user.cookie])assert.ok(!json.includes(secret));
      assert.equal((await f.request('/api/admin/users/'+randomUUID())).status,404);
      assert.equal((await f.request('/api/admin/users/not-a-uuid')).status,400);
    });
    await t.test('confirmed revoke is atomic and replay safe; admin sessions protected',async()=>{
      const body={confirmation:'revoke',reason:'security'};
      assert.equal((await f.request(userPath+'/sessions/revoke',{user:'other',body})).status,403);
      assert.equal((await f.request(userPath+'/sessions/revoke',{body:{reason:'security'}})).status,400);
      assert.equal((await f.request('/api/admin/users/'+f.users.admin.id+'/sessions/revoke',{body})).status,409);
      const replies=await Promise.all(Array.from({length:20},()=>f.request(userPath+'/sessions/revoke',{body})));
      assert.ok(replies.every(r=>r.status===200));assert.equal(replies.reduce((n,r)=>n+r.data.revoked,0),1);
      assert.equal((await f.query('SELECT disabled_at FROM users WHERE id=$1',[f.users.user.id])).rows[0].disabled_at,null);
      assert.equal((await f.request('/api/admin/users',{user:'user'})).status,401);
      assert.equal((await f.request('/api/auth/login',{user:null,body:{username:f.users.user.username,password:f.password}})).status,200);
      const events=(await f.query("SELECT * FROM operation_events WHERE action='user.revoke_sessions'")).rows;assert.equal(events.length,1);
      const eventPath='/api/admin/events/'+events[0].id;
      assert.equal((await f.request(eventPath,{user:'other'})).status,403);
      const detail=(await f.request(eventPath)).data;assert.equal(detail.resource_id,f.users.user.id);assert.equal(detail.metadata.sessions,1);
      assert.equal((await f.request('/api/admin/events/not-number')).status,400);
      assert.equal((await f.request('/api/admin/events/999999999')).status,404);
    });
  }finally{await f.close();}
});
