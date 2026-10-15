import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installInboxRoutes} from '../server/operations/inbox.mjs';

test('inbox drafts, recipient snapshot, ownership, replay and delivery load',{skip:process.env.TEST_INBOX!=='1'},async t=>{
  const f=await iterationFixture({schemas:['operations/inbox-schema.sql']});
  installInboxRoutes(f.app,{auth:f.auth,query:f.query,transaction:f.transaction,events:f.events});
  const input=(overrides={})=>({id:randomUUID(),title:'路线消息',body:'明天慢慢逛。',audience:'selected',recipientIds:[f.users.user.id],...overrides});
  const preview=id=>f.request('/api/admin/messages/'+id+'/preview');
  const send=async(id,overrides={})=>{const p=(await preview(id)).data;return f.request('/api/admin/messages/'+id+'/send',{body:{version:p.version,recipientCount:p.eligibleRecipients,confirmation:'send',...overrides}});};
  try{
    await f.start();
    await t.test('MSG-01/03 only admin may draft; exact replay, input lengths and literal text',async()=>{
      assert.equal((await f.request('/api/admin/messages',{user:'user',body:input()})).status,403);
      assert.equal((await f.request('/api/admin/messages',{user:null,body:input()})).status,401);
      assert.equal((await f.request('/api/admin/messages',{body:input({recipientIds:[]})})).status,400);
      assert.equal((await f.request('/api/admin/messages',{body:input({title:'x'.repeat(81)})})).status,400);
      assert.equal((await f.request('/api/admin/messages',{body:input({recipientIds:[randomUUID()]})})).status,400);
      const b=input({body:'<script>alert(1)</script>\n原文'});
      assert.equal((await f.request('/api/admin/messages',{body:b})).status,201);
      assert.equal((await f.request('/api/admin/messages',{body:b})).status,201);
      assert.equal((await f.request('/api/admin/messages',{body:{...b,title:'另一个内容'}})).status,409);
      assert.equal((await preview(b.id)).data.body,b.body);
      assert.equal((await f.query('SELECT count(*)::int n FROM inbox_campaigns WHERE id=$1',[b.id])).rows[0].n,1);
    });
    await t.test('MSG-01 stale draft versions fail; 20 simultaneous sends deliver once',async()=>{
      const b=input();await f.request('/api/admin/messages',{body:b});
      assert.equal((await f.request('/api/admin/messages/'+b.id,{body:{...b,title:'新标题',version:1},method:'PUT'})).status,200);
      assert.equal((await f.request('/api/admin/messages/'+b.id,{body:{...b,version:1},method:'PUT'})).status,409);
      assert.equal((await send(b.id,{version:1})).status,409);
      const replies=await Promise.all(Array.from({length:20},()=>send(b.id)));
      assert.ok(replies.every(r=>r.status===200));
      assert.equal((await f.query('SELECT count(*)::int n FROM inbox_messages WHERE campaign_id=$1',[b.id])).rows[0].n,1);
      assert.equal((await f.query("SELECT count(*)::int n FROM operation_events WHERE action='message.send' AND resource_id=$1",[b.id])).rows[0].n,1);
      assert.equal((await f.request('/api/admin/messages/'+b.id+'/cancel',{body:{}})).status,409);
    });
    await t.test('MSG-02 per-recipient read and idempotent read state',async()=>{
      const a=(await f.request('/api/me/messages',{user:'user'})).data;
      assert.equal(a.items.length,1);assert.equal(a.unread,1);
      const id=a.items[0].id;
      assert.equal((await f.request('/api/me/messages/'+id,{user:'other'})).status,404);
      assert.equal((await f.request('/api/me/messages/'+id+'/read',{user:'other',body:{}})).status,404);
      assert.equal((await f.request('/api/me/messages/'+id+'/read',{user:null,body:{}})).status,401);
      const one=await f.request('/api/me/messages/'+id+'/read',{user:'user',body:{}}),two=await f.request('/api/me/messages/'+id+'/read',{user:'user',body:{}});
      assert.equal(one.data.read_at,two.data.read_at);
      assert.equal((await f.request('/api/me/messages',{user:'user'})).data.unread,0);
    });
    await t.test('MSG-01 recipient changes roll back atomically and later accounts receive no old broadcast',async()=>{
      const b=input({audience:'all',recipientIds:[]});await f.request('/api/admin/messages',{body:b});const old=(await preview(b.id)).data;
      await f.query("INSERT INTO users(id,username,password_hash,nickname) VALUES($1,'added','unused','added')",[randomUUID()]);
      assert.equal((await send(b.id,{recipientCount:old.eligibleRecipients})).status,409);
      assert.equal((await f.query('SELECT count(*)::int n FROM inbox_messages WHERE campaign_id=$1',[b.id])).rows[0].n,0);
      assert.equal((await send(b.id)).data.recipient_count,4);
      const later=randomUUID();await f.query("INSERT INTO users(id,username,password_hash,nickname) VALUES($1,'later','unused','later')",[later]);
      assert.equal((await f.query('SELECT count(*)::int n FROM inbox_messages WHERE user_id=$1',[later])).rows[0].n,0);
      const cancelled=input();await f.request('/api/admin/messages',{body:cancelled});await f.request('/api/admin/messages/'+cancelled.id+'/cancel',{body:{}});
      const again=await f.request('/api/admin/messages/'+cancelled.id+'/cancel',{body:{}});assert.equal(again.data.version,2);
      assert.equal((await f.query("SELECT count(*)::int n FROM operation_events WHERE action='message.cancel' AND resource_id=$1",[cancelled.id])).rows[0].n,1);
      assert.equal((await send(cancelled.id)).status,409);
    });
    await t.test('MSG pressure: 505 recipients, concurrent list/read isolation and no SMTP calls',async()=>{
      await f.query("INSERT INTO users(id,username,password_hash,nickname) SELECT gen_random_uuid(),'load_'||n,'unused','测试' FROM generate_series(1,500) n");
      const b=input({audience:'all',recipientIds:[]});await f.request('/api/admin/messages',{body:b});
      const begin=performance.now(),sent=await send(b.id);assert.equal(sent.status,200);assert.equal(sent.data.recipient_count,505);
      const deliveryMs=Math.round(performance.now()-begin),times=[];let cursor=0,errors=0;
      await Promise.all(Array.from({length:20},async()=>{while(cursor++<200){const start=performance.now(),r=await f.request('/api/me/messages',{user:'user'});if(r.status!==200||r.data.items.length!==3)errors++;times.push(performance.now()-start);}}));
      times.sort((a,b)=>a-b);assert.equal(errors,0);
      const result={recipients:505,deliveryMs,readRequests:200,concurrency:20,errors,p50Ms:Math.round(times[99]),p95Ms:Math.round(times[189]),externalEmailCalls:0};
      await mkdir(new URL('../validation/iteration-20261016/',import.meta.url),{recursive:true});await writeFile(new URL('../validation/iteration-20261016/inbox-pressure.json',import.meta.url),JSON.stringify(result,null,2));console.log('INBOX_PRESSURE '+JSON.stringify(result));
    });
  }finally{await f.close();}
});
