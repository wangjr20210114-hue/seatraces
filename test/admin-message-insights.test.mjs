import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installInboxRoutes} from '../server/operations/inbox.mjs';
import {installMessageInsights} from '../server/operations/message-insights.mjs';
test('campaign effects and segment snapshot use the normal draft/send workflow',{skip:process.env.TEST_OPERATIONS!=='1'},async t=>{
  const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','agent/schema.sql','operations/inbox-schema.sql','citywalk-expansion-schema.sql','operations/product-schema.sql','operations/analytics-schema.sql']});
  installInboxRoutes(f.app,f);installMessageInsights(f.app,f);const id=randomUUID();
  try{
    await f.start();
    await t.test('ME01 segments exclude staff/tests/disabled and do not send anything',async()=>{
      await f.query('UPDATE users SET analytics_excluded=true WHERE id=$1',[f.users.other.id]);
      const v=await f.request('/api/admin/messages/audience?segment=new');assert.equal(v.status,200);assert.equal(v.data.items.length,1);assert.equal(v.data.items[0].id,f.users.user.id);
      assert.equal((await f.query('SELECT count(*)::int n FROM inbox_campaigns')).rows[0].n,0);
      assert.equal((await f.request('/api/admin/messages/audience?segment=arbitrary')).status,400);
      assert.equal((await f.request('/api/admin/messages/audience?segment=new',{user:null})).status,401);
    });
    await t.test('ME02 ordinary draft/preview/send/read then effects; no external delivery claim',async()=>{
      await f.request('/api/admin/messages',{body:{id,title:'行程提醒',body:'PRIVATE_BODY',audience:'selected',recipientIds:[f.users.user.id,f.users.other.id]}});
      const p=(await f.request('/api/admin/messages/'+id+'/preview')).data;
      assert.equal((await f.request('/api/admin/messages/'+id+'/send',{body:{version:p.version,recipientCount:p.eligibleRecipients,confirmation:'send'}})).status,200);
      const m=(await f.request('/api/me/messages',{user:'user'})).data.items[0];await f.request('/api/me/messages/'+m.id+'/read',{user:'user',body:{}});
      const v=(await f.request('/api/admin/messages/'+id+'/effects')).data;assert.equal(v.totals.read,1);assert.equal(v.totals.unread,1);assert.equal(v.totals.readRate,50);assert.equal(v.daily[0].first_reads,1);assert.ok(!JSON.stringify(v).includes('PRIVATE_BODY'));
      assert.equal((await f.request('/api/admin/messages/'+id+'/effects?state=unread')).data.items[0].username,f.users.other.username);
      assert.equal((await f.request('/api/admin/messages/'+id+'/effects',{user:'user'})).status,403);
    });
    await t.test('ME03 owned campaigns only and rate uses remaining recipient records',async()=>{
      const foreign=randomUUID();await f.query("INSERT INTO inbox_campaigns(id,created_by,title,body,audience) VALUES($1,$2,'其他','其他','all')",[foreign,f.users.other.id]);
      assert.equal((await f.request('/api/admin/messages/'+foreign+'/effects')).status,404);
      await f.query('DELETE FROM inbox_messages WHERE campaign_id=$1 AND user_id=$2',[id,f.users.other.id]);
      const v=(await f.request('/api/admin/messages/'+id+'/effects')).data;assert.equal(v.totals.removedRecipientRecords,1);assert.equal(v.totals.readRate,100);assert.equal(v.campaign.recipient_count,2);
    });
    await t.test('ME04 500 recipient ceiling rejects truncation; 80 concurrent effect reads',async()=>{
      await f.query("INSERT INTO users(id,username,password_hash,nickname) SELECT gen_random_uuid(),'bulk_'||n,'unused','批量测试' FROM generate_series(1,501) n");
      assert.equal((await f.request('/api/admin/messages/audience?segment=new')).status,422);
      let n=0;const ms=[];await Promise.all(Array.from({length:8},async()=>{while(n<80){n++;const s=performance.now();assert.equal((await f.request('/api/admin/messages/'+id+'/effects')).status,200);ms.push(performance.now()-s);}}));ms.sort((a,b)=>a-b);console.log('PRESSURE message effects: 80 requests/concurrency 8, p95='+Math.round(ms[76])+'ms');
    });
  }finally{await f.close();}
});
