/* 验证邮件配置与投递查询。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {createOutboxMailer,installMailOutboxRoutes} from '../server/services/mail-outbox.mjs';
import {routePermission} from '../server/operations/permissions.mjs';

const env={MAIL_PROVIDER:'tencent_ses',APP_ORIGIN:'https://trip.example.test',SES_REGION:'ap-guangzhou',
 SES_SECRET_ID:'private-id',SES_SECRET_KEY:'private-key',SES_FROM:'noreply@example.test',
 SES_TEMPLATE_VERIFY_EMAIL:'1',SES_TEMPLATE_RESET_PASSWORD:'2',SES_TEMPLATE_PASSWORD_CHANGED:'3',
 MAIL_OUTBOX_KEY:randomBytes(32).toString('base64')};
const integration={skip:process.env.TEST_MAIL_OUTBOX!=='1',timeout:60000};

test('mail management routes have explicit read/manage permissions',()=>{
 for(const p of ['status','jobs','history'])assert.equal(routePermission('GET','/mail/'+p),'system.read');
 assert.equal(routePermission('POST','/mail/verify'),'system.manage');
 assert.equal(routePermission('POST','/mail/send'),null);
});

test('admin mail verification is private, audited, non-sending and throttled under concurrency',integration,async()=>{
 const f=await iterationFixture({schemas:['mail-outbox-schema.sql']});
 try{
  let checks=0,sends=0,clock=0,mode='pass';
  const transport={enabled:true,send:async()=>sends++,verify:async()=>{checks++;await new Promise(r=>setTimeout(r,25));
   if(mode==='fail')throw Object.assign(Error('private-key recipient@example.test token'),{mailDelivery:{code:'SES_TEMPLATE_NOT_APPROVED'}});
  }};
  const mailer=createOutboxMailer({...f,transport,env});
  installMailOutboxRoutes(f.app,{query:f.query,mailer,now:()=>clock});await f.start();
  for(const path of ['status','jobs','history','verify'])for(const user of [null,'user']){
   const r=await f.request('/api/admin/mail/'+path,{user,...(path==='verify'?{body:{}}:{})});
   assert.equal(r.status,user?403:401);
  }
  assert.equal((await f.request('/api/admin/mail/verify',{body:{to:'recipient@example.test'}})).status,400);
  const results=await Promise.all(Array.from({length:20},()=>f.request('/api/admin/mail/verify',{body:{}})));
  assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===429).length,19);
  assert.equal(checks,1);assert.equal(sends,0);
  assert.equal(results.find(r=>r.status===200).data.messageSent,false);
  let status=await f.request('/api/admin/mail/status');assert.equal(status.data.lastVerification.metadata.passed,true);
  clock+=30000;mode='fail';const failed=await f.request('/api/admin/mail/verify',{body:{}});
  assert.equal(failed.status,200);assert.equal(failed.data.passed,false);assert.equal(failed.data.code,'SES_TEMPLATE_NOT_APPROVED');
  const history=await f.request('/api/admin/mail/history');assert.equal(history.data.items.length,2);
  assert.equal(history.data.items[0].action,'mail.configuration.verified');
  assert.equal((await f.query("SELECT 1 FROM operation_events WHERE action='mail.configuration.verified' AND user_id=$1",[f.users.admin.id])).rowCount,2);
  const output=JSON.stringify([status.data,failed.data,history.data]);
  for(const secret of ['private-id','private-key','recipient@example.test',env.MAIL_OUTBOX_KEY])assert.equal(output.includes(secret),false);
  assert.equal((await f.query('SELECT 1 FROM mail_outbox')).rowCount,0);
 }finally{await f.close();}
});

test('unconfigured verification records a safe failure without contacting a provider',integration,async()=>{
 const f=await iterationFixture({schemas:['mail-outbox-schema.sql']});
 try{
  const mailer=createOutboxMailer({...f,env:{},transport:{enabled:false,verify:()=>{throw Error('must not call');}}});
  installMailOutboxRoutes(f.app,{query:f.query,mailer});await f.start();
  const r=await f.request('/api/admin/mail/verify',{body:{}});
  assert.equal(r.data.code,'MAIL_NOT_CONFIGURED');assert.equal(r.data.messageSent,false);
  assert.equal((await f.request('/api/admin/mail/history')).data.items[0].metadata.passed,false);
 }finally{await f.close();}
});

test('mail audit records queue and outcomes, dedupes events, masks errors and cannot cause replay',integration,async()=>{
 const f=await iterationFixture({schemas:['mail-outbox-schema.sql']});
 try{
  let sends=0,mode='pass';const transport={enabled:true,send:async()=>{sends++;
   if(mode==='fail')throw Object.assign(Error('recipient@example.test private-key'),{mailDelivery:{state:'failed',code:'SES_REQUEST_REJECTED'}});
  }};
  const mailer=createOutboxMailer({...f,env,transport});
  await mailer.send({to:'recipient@example.test',purpose:'password_changed'});await mailer.tick();
  mode='fail';await mailer.send({to:'recipient@example.test',purpose:'password_changed'});await mailer.tick();
  await f.events.flush();const events=(await f.query("SELECT action,resource_id,metadata FROM operation_events WHERE action LIKE 'mail.%' ORDER BY id")).rows;
  assert.deepEqual(events.map(v=>v.action),['mail.delivery.queued','mail.delivery.sent','mail.delivery.queued','mail.delivery.failed']);
  assert.equal(events[3].metadata.code,'SES_REQUEST_REJECTED');
  assert.equal(JSON.stringify(events).includes('recipient@example.test'),false);
  assert.equal(JSON.stringify(events).includes('private-key'),false);
  mode='pass';const broken=createOutboxMailer({...f,env,transport,events:{record(){throw Error('audit unavailable');}}});
  await broken.send({to:'recipient@example.test',purpose:'password_changed'});await broken.tick();await broken.tick();
  assert.equal(sends,3);assert.equal((await f.query("SELECT 1 FROM mail_outbox WHERE state='sent'")).rowCount,2);
 }finally{await f.close();}
});
