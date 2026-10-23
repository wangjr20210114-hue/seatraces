/* 验证腾讯云邮件签名与发送。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createMailer} from '../server/mail.mjs';
import {sesHeaders} from '../server/tencent-ses.mjs';
import {mailConfiguration,deliveryFailure,createOutboxMailer} from '../server/services/mail-outbox.mjs';
import {iterationFixture} from './helpers/iteration-db.mjs';

const env={MAIL_PROVIDER:'tencent_ses',APP_ORIGIN:'https://trip.example.test',SES_REGION:'ap-guangzhou',
  SES_SECRET_ID:'AKIDEXAMPLE',SES_SECRET_KEY:'example-secret-key',SES_FROM:'noreply@notify.example.test',
  SES_TEMPLATE_VERIFY_EMAIL:'101',SES_TEMPLATE_RESET_PASSWORD:'102',SES_TEMPLATE_PASSWORD_CHANGED:'103',
  MAIL_OUTBOX_KEY:randomBytes(32).toString('base64')};
const message={to:'recipient@example.test',purpose:'verify_email',token:'a'.repeat(64)};
const reply=data=>({status:200,text:JSON.stringify({Response:data})});
const apiError=code=>reply({Error:{Code:code,Message:'secret vendor text recipient@example.test'}});
const validRead=(headers,body)=>{
  const p=JSON.parse(body);
  if(headers['X-TC-Action']==='GetEmailIdentity')return reply({VerifiedForSendingStatus:true});
  const purpose=p.TemplateID===101?'verify_email':'reset_password';
  return reply({TemplateStatus:0,TemplateContent:{Text:Buffer.from(p.TemplateID===103?'密码已修改':`点击 ${env.APP_ORIGIN}/login.html#action=${purpose}&token={{token}}`).toString('base64')}});
};

test('SES configuration is explicit, fail-closed and never exposes secret values',()=>{
  assert.equal(mailConfiguration(env).enabled,true);
  assert.equal(mailConfiguration({...env,SES_SECRET_KEY:''}).enabled,false);
  assert.equal(mailConfiguration({...env,SES_TEMPLATE_RESET_PASSWORD:''}).enabled,false);
  assert.equal(mailConfiguration({...env,SES_TEMPLATE_RESET_PASSWORD:'1e3'}).enabled,false);
  assert.equal(mailConfiguration({...env,SES_REGION:'ap-shanghai'}).enabled,false);
  assert.equal(mailConfiguration({...env,SES_FROM:'attacker@example.test\r\nBcc: other@example.test'}).enabled,false);
  assert.equal(mailConfiguration({...env,APP_ORIGIN:'https://attacker:password@example.test'}).enabled,false);
  assert.equal(mailConfiguration({...env,APP_ORIGIN:'https://example.test/path'}).enabled,false);
  assert.equal(mailConfiguration({...env,MAIL_PROVIDER:'typo'}).enabled,false);
  assert.equal(createMailer({...env,SES_SECRET_KEY:''}).enabled,false);
  const status=JSON.stringify(mailConfiguration(env));
  for(const value of [env.SES_SECRET_ID,env.SES_SECRET_KEY,env.MAIL_OUTBOX_KEY,env.SES_FROM])assert.ok(!status.includes(value));
});

test('TC3 signature matches independent Python vector, signs the action and uses UTC date',()=>{
  const h=sesHeaders(env,'GetEmailTemplate','{"TemplateID":101}',1551113065);
  assert.equal(h.Authorization,'TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2019-02-25/ses/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=a37ef5d9afad58fbf00e5740e7b67d2e3f7f3f309e80496626ed26f06f8af6ed');
  assert.equal(h.Host,'ses.tencentcloudapi.com');assert.equal(h['X-TC-Region'],'ap-guangzhou');
  assert.notEqual(sesHeaders(env,'SendEmail','{"TemplateID":101}',1551113065).Authorization,h.Authorization);
  assert.notEqual(sesHeaders(env,'GetEmailTemplate','{"TemplateID":102}',1551113065).Authorization,h.Authorization);
});

for(const [purpose,id] of [['verify_email',101],['reset_password',102],['password_changed',103]]){
  test(`SES ${purpose} sends one recipient with correct template and fragment token`,async()=>{
    const calls=[];
    const mailer=createMailer(env,{postRequest:async(h,body)=>{calls.push({h,p:JSON.parse(body)});return reply({MessageId:'accepted-id'});}});
    const token=purpose==='password_changed'?undefined:message.token;
    assert.deepEqual(await mailer.send({to:message.to,purpose,...(token?{token}:{}),messageId:'<fixed-id@trip.example.test>'}),{accepted:true});
    assert.equal(calls.length,1);const {h,p}=calls[0];
    assert.equal(h['X-TC-Action'],'SendEmail');assert.deepEqual(p.Destination,[message.to]);
    assert.equal(p.Template.TemplateID,id);assert.equal(p.FromEmailAddress,env.SES_FROM);
    assert.equal(p.TriggerType,1);assert.equal(p.SmtpMessageId,'<fixed-id@trip.example.test>');
    const data=JSON.parse(p.Template.TemplateData);
    if(token){assert.deepEqual(data,{token});assert.ok(!JSON.stringify(data).includes('https://'));}
    else assert.deepEqual(data,{});
    assert.ok(!JSON.stringify(p).includes(env.SES_SECRET_KEY));
  });
}

test('SES verifies only domain and three templates, without sending any mail',async()=>{
  const actions=[];
  const mailer=createMailer(env,{postRequest:async(h,b)=>{actions.push(h['X-TC-Action']);return validRead(h,b);}});
  assert.deepEqual(await mailer.verify(),{domainVerified:true,templatesApproved:true});
  assert.deepEqual(actions,['GetEmailIdentity','GetEmailTemplate','GetEmailTemplate','GetEmailTemplate']);
});

test('SES verification fails for unverified domains, unapproved or incompatible templates',async()=>{
  const domain=createMailer(env,{postRequest:async()=>reply({VerifiedForSendingStatus:false})});
  await assert.rejects(domain.verify(),e=>e.mailDelivery.code==='SES_DOMAIN_NOT_VERIFIED');
  for(const value of [{TemplateStatus:1},{TemplateStatus:2},{TemplateStatus:0,TemplateContent:{Text:Buffer.from('{{wrong}}').toString('base64')}}]){
    const m=createMailer(env,{postRequest:async(h,b)=>h['X-TC-Action']==='GetEmailIdentity'?validRead(h,b):reply(value)});
    await assert.rejects(m.verify(),e=>/^SES_TEMPLATE_/.test(e.mailDelivery.code));
  }
});

for(const [name,content,code] of [
  ['whole variable URL','{{link}}','SES_TEMPLATE_VARIABLES_INVALID'],
  ['wrong domain','https://other.example.test/login.html#action=verify_email&token={{token}}','SES_TEMPLATE_LINK_INVALID'],
  ['wrong action',`${env.APP_ORIGIN}/login.html#action=reset_password&token={{token}}`,'SES_TEMPLATE_LINK_INVALID'],
  ['token in query',`${env.APP_ORIGIN}/login.html?action=verify_email&token={{token}}`,'SES_TEMPLATE_LINK_INVALID'],
  ['token alone','{{token}}','SES_TEMPLATE_LINK_INVALID'],
  ['extra token link',`${env.APP_ORIGIN}/login.html#action=verify_email&token={{token}} https://other.example.test/{{token}}`,'SES_TEMPLATE_LINK_INVALID'],
])test(`SES reviewed links reject ${name}`,async()=>{
  const m=createMailer(env,{postRequest:async(h,b)=>h['X-TC-Action']==='GetEmailIdentity'?validRead(h,b):reply({TemplateStatus:0,TemplateContent:{Text:Buffer.from(content).toString('base64')}})});
  await assert.rejects(m.verify(),e=>e.mailDelivery.code===code);
});

test('SES accepts fixed links in HTML with escaped ampersands',async()=>{
  const m=createMailer(env,{postRequest:async(h,b)=>{
    const response=validRead(h,b);
    if(h['X-TC-Action']==='GetEmailTemplate'){
      const data=JSON.parse(response.text).Response;
      const text=Buffer.from(data.TemplateContent.Text,'base64').toString('utf8').replaceAll('&','&amp;');
      return reply({...data,TemplateContent:{Html:Buffer.from(`<p>${text}</p>`).toString('base64')}});
    }
    return response;
  }});
  assert.equal((await m.verify()).templatesApproved,true);
});

for(const [name,result,expected] of [
  ['throttle',apiError('RequestLimitExceeded'),'retry'],
  ['recipient throttle',apiError('FailedOperation.FrequencyLimit'),'retry'],
  ['credentials',apiError('AuthFailure.SignatureFailure'),'failed'],
  ['permissions',apiError('UnauthorizedOperation'),'failed'],
  ['unapproved template',apiError('FailedOperation.InvalidTemplateID'),'failed'],
  ['internal failure',apiError('InternalError'),'unknown'],
  ['invalid response',{status:502,text:'gateway error'},'unknown'],
  ['missing acceptance id',reply({RequestId:'no-message-id'}),'unknown'],
  ['malformed error code',reply({Error:{Code:{unsafe:'object'}}}),'unknown'],
])test(`SES ${name}: ${expected}, no hidden retry and no vendor content leakage`,async()=>{
  let count=0;const mailer=createMailer(env,{postRequest:async()=>{count++;return result;}});
  await assert.rejects(mailer.send(message),e=>{assert.equal(deliveryFailure(e).state,expected);assert.ok(!e.message.includes('recipient'));assert.ok(!e.message.includes('secret vendor'));return true;});
  assert.equal(count,1);
});

test('SES network failures distinguish pre-connect rejection from uncertain acceptance',async()=>{
  for(const code of ['ECONNRESET','ETIMEDOUT','ECONNREFUSED','ENOTFOUND']){
    const m=createMailer(env,{postRequest:async()=>{throw Object.assign(Error('vendor token secret'),{code});}});
    await assert.rejects(m.send(message),e=>{assert.equal(deliveryFailure(e).state,['ECONNREFUSED','ENOTFOUND'].includes(code)?'retry':'unknown');assert.ok(!e.message.includes('vendor'));return true;});
  }
});

test('invalid purposes, recipients, tokens and message headers never reach Tencent',async()=>{
  let calls=0;const m=createMailer(env,{postRequest:async()=>{calls++;return reply({MessageId:'id'});}});
  for(const bad of [{...message,purpose:'bulk'},{...message,to:'a@example.test\nBcc: b@example.test'},
    {...message,token:'not-a-token'},{...message,messageId:'<a>\r\nBcc: a@example.test'},{to:message.to,purpose:'reset_password'}])await assert.rejects(m.send(bad));
  assert.equal(calls,0);
});

test('SMTP remains compatible and keeps TLS, timeouts and single-recipient validation',async()=>{
  let settings,sent;
  const smtp={APP_ORIGIN:env.APP_ORIGIN,SMTP_HOST:'smtp.example.test',SMTP_USER:'fixture',SMTP_PASSWORD:'fixture',SMTP_FROM:env.SES_FROM};
  const m=createMailer(smtp,{createTransport:options=>{settings=options;return {verify:async()=>true,sendMail:async value=>{sent=value;return {accepted:[message.to]};}};}});
  assert.equal(m.provider,'smtp');await m.verify();await m.send(message);
  assert.equal(settings.secure,true);assert.equal(settings.disableFileAccess,true);assert.equal(settings.disableUrlAccess,true);
  assert.equal(sent.to,message.to);assert.ok(sent.text.includes('#action=verify_email&token='));
  const starttls=createMailer({...smtp,SMTP_PORT:'587'},{createTransport:o=>{assert.equal(o.secure,false);assert.equal(o.requireTLS,true);return {verify:async()=>true};}});
  await starttls.verify();
});

test('published templates render fixed production URLs consumed by the existing login page',async()=>{
  for(const [purpose,file] of [['verify_email','verify-email'],['reset_password','reset-password'],['password_changed','password-changed']]){
    const text=await readFile(new URL('../config/mail-templates/'+file+'.txt',import.meta.url),'utf8');
    assert.equal(text.includes('{{token}}'),purpose!=='password_changed');
    assert.equal(text.includes('{{link}}'),false);
    assert.ok(!text.includes('SecretKey'));
    if(purpose!=='password_changed'){
      const rendered=text.replace('{{token}}',message.token),match=rendered.match(/https:\/\/[^\s]+/);
      assert.ok(match);const url=new URL(match[0]),fragment=new URLSearchParams(url.hash.slice(1));
      assert.equal(url.origin,'https://trip.seatraces.com');assert.equal(url.pathname,'/login.html');assert.equal(url.search,'');
      assert.equal(fragment.get('token'),message.token);assert.equal(fragment.get('action'),purpose);
    }
  }
});

test('SES with PostgreSQL outbox: duplicate enqueue, uncertainty without replay, retry and private state',
  {skip:process.env.TEST_MAIL_OUTBOX!=='1',timeout:60000},async()=>{
    const f=await iterationFixture({schemas:['mail-outbox-schema.sql']});
    try{
      let calls=0,mode='reset';
      const transport=createMailer(env,{postRequest:async()=>{calls++;if(mode==='reset')throw Object.assign(Error('secret response'),{code:'ECONNRESET'});if(mode==='throttle')return apiError('RequestLimitExceeded');return reply({MessageId:'accepted'});}});
      const mailer=createOutboxMailer({...f,env,transport});
      await f.query("INSERT INTO account_tokens(token_hash,user_id,purpose,email,expires_at) VALUES($1,$2,'verify_email',$3,now()+interval '30 minutes')",[createHash('sha256').update(message.token).digest('hex'),f.users.user.id,message.to]);
      await Promise.all(Array.from({length:20},()=>mailer.send(message)));
      assert.equal((await f.query('SELECT 1 FROM mail_outbox')).rowCount,1);
      await mailer.tick();await mailer.tick();assert.equal(calls,1);
      const unknown=(await f.query('SELECT state,last_error FROM mail_outbox')).rows[0];
      assert.deepEqual(unknown,{state:'unknown',last_error:'SES_ACCEPTANCE_UNKNOWN'});
      mode='throttle';await mailer.send({to:message.to,purpose:'password_changed'});await mailer.tick();
      const retry=(await f.query("SELECT id,last_error FROM mail_outbox WHERE state='retry'")).rows[0];assert.equal(retry.last_error,'SES_THROTTLED');
      mode='accepted';await f.query('UPDATE mail_outbox SET next_at=now() WHERE id=$1',[retry.id]);await mailer.tick();
      const sent=(await f.query('SELECT state,payload FROM mail_outbox WHERE id=$1',[retry.id])).rows[0];assert.equal(sent.state,'sent');assert.equal(sent.payload,null);
      assert.equal(calls,3);
    }finally{await f.close();}
  });
