import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {mailConfiguration,encryptMail,decryptMail,deliveryFailure,createOutboxMailer,installMailOutboxRoutes} from '../server/services/mail-outbox.mjs';
const env={SMTP_HOST:'smtp.example.test',SMTP_USER:'fixture',SMTP_PASSWORD:'fixture',SMTP_FROM:'noreply@example.test',APP_ORIGIN:'https://trip.example.test',MAIL_OUTBOX_KEY:randomBytes(32).toString('base64')};
test('outbox encrypts addresses and tokens, detects tampering and keeps config values private',()=>{
 const key=Buffer.from(env.MAIL_OUTBOX_KEY,'base64'),value={to:'recipient@example.test',purpose:'verify_email',token:'a'.repeat(64)},sealed=encryptMail(value,key);
 assert.deepEqual(decryptMail(sealed,key),value);assert.ok(!sealed.payload.toString().includes(value.token));assert.ok(!sealed.payload.toString().includes(value.to));
 const bad={...sealed,tag:Buffer.from(sealed.tag)};bad.tag[0]^=1;assert.throws(()=>decryptMail(bad,key));
 assert.equal(mailConfiguration(env).enabled,true);assert.ok(!JSON.stringify(mailConfiguration(env)).includes(env.SMTP_PASSWORD));
 assert.equal(mailConfiguration({}).enabled,false);assert.equal(mailConfiguration({...env,MAIL_OUTBOX_KEY:'bad'}).enabled,false);
 assert.equal(deliveryFailure({command:'DATA'}).state,'unknown');assert.equal(deliveryFailure({responseCode:550}).state,'failed');assert.equal(deliveryFailure({code:'ECONNRESET'}).state,'retry');
});
test('durable mail: duplicate enqueue, success erasure, invalid token, retry, uncertainty, restart and private admin views',
 {skip:process.env.TEST_MAIL_OUTBOX!=='1',timeout:60000},async()=>{
 const f=await iterationFixture({schemas:['mail-outbox-schema.sql']});
 try{
  let sent=0,mode='success';const transport={enabled:true,send:async m=>{sent++;assert.match(m.messageId,/^<[\da-f-]{36}@trip\.example\.test>$/);
   if(mode==='retry')throw Object.assign(Error('secret SMTP text'),{code:'ECONNREFUSED'});
   if(mode==='unknown')throw Object.assign(Error('secret SMTP text'),{command:'DATA'});
  }};
  const mailer=createOutboxMailer({...f,env,transport});installMailOutboxRoutes(f.app,{query:f.query,mailer});await f.start();
  const token='a'.repeat(64),value={to:'recipient@example.test',purpose:'verify_email',token};
  await f.query("INSERT INTO account_tokens(token_hash,user_id,purpose,email,expires_at) VALUES($1,$2,'verify_email',$3,now()+interval '30 minutes')",[createHash('sha256').update(token).digest('hex'),f.users.user.id,value.to]);
  await Promise.all(Array.from({length:12},()=>mailer.send(value)));
  assert.equal((await f.query('SELECT 1 FROM mail_outbox')).rowCount,1);
  await mailer.tick();assert.equal(sent,1);
  const first=(await f.query('SELECT * FROM mail_outbox')).rows[0];assert.equal(first.state,'sent');assert.equal(first.payload,null);
  await mailer.send({...value,token:'b'.repeat(64)});await mailer.tick();assert.equal(sent,1);
  assert.equal((await f.query("SELECT 1 FROM mail_outbox WHERE state='expired'")).rowCount,1);
  mode='retry';await mailer.send({to:value.to,purpose:'password_changed'});await mailer.tick();
  const retry=(await f.query("SELECT * FROM mail_outbox WHERE state='retry'")).rows[0];assert.equal(retry.attempts,1);assert.equal(retry.last_error,'SMTP_TEMPORARY');
  mode='success';await f.query('UPDATE mail_outbox SET next_at=now() WHERE id=$1',[retry.id]);await mailer.tick();assert.equal((await f.query('SELECT state FROM mail_outbox WHERE id=$1',[retry.id])).rows[0].state,'sent');
  mode='unknown';await mailer.send({to:value.to,purpose:'password_changed'});await mailer.tick();const count=sent;await mailer.tick();assert.equal(sent,count);
  assert.equal((await f.query("SELECT 1 FROM mail_outbox WHERE state='unknown'")).rowCount,1);
  await mailer.send({to:value.to,purpose:'password_changed'});await f.query("UPDATE mail_outbox SET state='sending',lease_until=now()-interval '1 second' WHERE state='queued'");await mailer.tick();
  assert.equal(sent,count);assert.equal((await f.query("SELECT 1 FROM mail_outbox WHERE last_error='WORKER_INTERRUPTED'")).rowCount,1);
  assert.equal((await f.request('/api/admin/mail/status',{user:'user'})).status,403);
  const status=await f.request('/api/admin/mail/status');assert.equal(status.status,200);
  const jobs=await f.request('/api/admin/mail/jobs');assert.equal(jobs.status,200);
  assert.ok(!JSON.stringify(jobs.data).includes(value.to)&&!JSON.stringify(jobs.data).includes(token)&&!JSON.stringify(jobs.data).includes('secret SMTP text'));
  await f.query("UPDATE mail_outbox SET expires_at=now()-interval '1 second' WHERE state='unknown'");await mailer.tick();
  assert.equal((await f.query("SELECT 1 FROM mail_outbox WHERE state='unknown' AND payload IS NOT NULL")).rowCount,0);
 }finally{await f.close();}
});
