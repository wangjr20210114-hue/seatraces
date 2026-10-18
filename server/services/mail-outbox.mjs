import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {requireManagement} from '../operations/permissions.mjs';
import {mailTransportConfiguration} from '../mail-config.mjs';
const message=z.object({to:z.email().max(254),purpose:z.enum(['verify_email','reset_password','password_changed']),token:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().refine(v=>v.purpose==='password_changed'||v.token);
const fail=s=>Object.assign(Error(s),{status:503});
export function mailConfiguration(env=process.env){
  const config=mailTransportConfiguration(env),missing=[...config.missing,...(env.MAIL_OUTBOX_KEY?[]:['MAIL_OUTBOX_KEY'])];
  const key=env.MAIL_OUTBOX_KEY?Buffer.from(env.MAIL_OUTBOX_KEY,'base64'):null;
  return {...config,enabled:config.enabled&&key?.length===32,missing,keyValid:!env.MAIL_OUTBOX_KEY||key?.length===32};
}
export function encryptMail(value,key){
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
 return {payload:Buffer.concat([cipher.update(JSON.stringify(message.parse(value)),'utf8'),cipher.final()]),nonce,tag:cipher.getAuthTag()};
}
export function decryptMail(row,key){
 const c=createDecipheriv('aes-256-gcm',key,row.nonce);c.setAuthTag(row.tag);
 return message.parse(JSON.parse(Buffer.concat([c.update(row.payload),c.final()]).toString('utf8')));
}
export function deliveryFailure(error){
 if(error?.mailDelivery&&['failed','retry','unknown'].includes(error.mailDelivery.state)&&/^SES_[A-Z_]+$/.test(error.mailDelivery.code))return error.mailDelivery;
 if(error?.command==='DATA')return {state:'unknown',code:'SMTP_ACCEPTANCE_UNKNOWN'};
 if(error?.code==='EAUTH'||Number(error?.responseCode)>=500)return {state:'failed',code:'SMTP_REJECTED'};
 return {state:'retry',code:'SMTP_TEMPORARY'};
}
export function createOutboxMailer({query,transaction,transport,events,env=process.env,intervalMs=5000}={}){
 const config=mailConfiguration(env),enabled=Boolean(config.enabled&&transport.enabled),key=enabled?Buffer.from(env.MAIL_OUTBOX_KEY,'base64'):null;
 let running=false,timer;
 function audit(job,state,code){
  // Delivery state is durable in mail_outbox. An audit sink failure must never
  // replay a message already accepted by the provider.
  try{events?.record({kind:'system',action:'mail.delivery.'+state,resourceId:job.id,
   metadata:{provider:config.provider,purpose:job.purpose,attempts:job.attempts||0,...(code?{code}:{})}});}catch{}
 }
 async function send(input){
  if(!enabled)throw fail('邮件服务尚未完成配置');
  const value=message.parse(input),id=randomUUID(),sealed=encryptMail(value,key);
  // Token hash forms the idempotency key; it cannot be used as a recovery token.
  // Password-change notifications have no token and are distinct notifications.
  const dedupe=createHash('sha256').update(JSON.stringify([value.to,value.purpose,value.token||id])).digest('hex');
  const inserted=await transaction(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(20261028)');
    const size=(await c.query("SELECT 1 FROM mail_outbox WHERE state IN ('queued','retry','sending') LIMIT 1001")).rowCount;
    if(size>=1000)throw fail('邮件队列较繁忙，请稍后重试');
    return (await c.query(`INSERT INTO mail_outbox(id,dedupe_key,purpose,state,payload,nonce,tag,expires_at) VALUES($1,$2,$3,'queued',$4,$5,$6,now()+interval '25 minutes') ON CONFLICT(dedupe_key) DO NOTHING`,[id,dedupe,value.purpose,sealed.payload,sealed.nonce,sealed.tag])).rowCount;
  });if(inserted)audit({id,purpose:value.purpose},'queued');return {queued:true};
 }
 async function tick(){
  if(!enabled||running)return;running=true;
  try{
   const job=await transaction(async c=>{
    // A crash after SMTP acceptance cannot safely be auto-replayed.
    await c.query("UPDATE mail_outbox SET state='unknown',last_error='WORKER_INTERRUPTED',updated_at=now() WHERE state='sending' AND lease_until<now()");
    await c.query("UPDATE mail_outbox SET state=CASE WHEN state IN ('queued','retry') THEN 'expired' ELSE state END,payload=NULL,nonce=NULL,tag=NULL,updated_at=now() WHERE expires_at<=now() AND payload IS NOT NULL AND state<>'sending'");
    const r=(await c.query("SELECT id FROM mail_outbox WHERE state IN ('queued','retry') AND next_at<=now() AND expires_at>now() AND attempts<4 ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
    if(!r)return null;
    return (await c.query("UPDATE mail_outbox SET state='sending',attempts=attempts+1,lease_until=now()+interval '90 seconds',updated_at=now() WHERE id=$1 RETURNING *",[r.id])).rows[0];
   });
   if(!job)return;
   let value;
   try{value=decryptMail(job,key);}catch{await query("UPDATE mail_outbox SET state='failed',last_error='PAYLOAD_INVALID',payload=NULL,nonce=NULL,tag=NULL,updated_at=now() WHERE id=$1",[job.id]);audit(job,'failed','PAYLOAD_INVALID');return;}
   if(value.token){
    const valid=(await query("SELECT 1 FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.purpose=$2 AND t.email=$3 AND t.used_at IS NULL AND t.expires_at>now() AND u.disabled_at IS NULL",[createHash('sha256').update(value.token).digest('hex'),value.purpose,value.to])).rowCount;
    if(!valid){await query("UPDATE mail_outbox SET state='expired',last_error='TOKEN_INVALID',payload=NULL,nonce=NULL,tag=NULL,updated_at=now() WHERE id=$1",[job.id]);audit(job,'expired','TOKEN_INVALID');return;}
   }
   let accepted=false;
   try{
    await transport.send({...value,messageId:`<${job.id}@${new URL(env.APP_ORIGIN).hostname}>`});
    accepted=true;
    await query("UPDATE mail_outbox SET state='sent',payload=NULL,nonce=NULL,tag=NULL,last_error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id]);
    audit(job,'sent');
   }catch(error){
    const result=accepted?{state:'unknown',code:config.provider==='tencent_ses'?'SES_ACCEPTED_DATABASE_UNCERTAIN':'SMTP_ACCEPTED_DATABASE_UNCERTAIN'}:deliveryFailure(error),state=result.state==='retry'&&job.attempts>=4?'failed':result.state,delay=[30,120,600,600][job.attempts-1];
    await query("UPDATE mail_outbox SET state=$2,last_error=$3,next_at=now()+($4::int*interval '1 second'),lease_until=NULL,updated_at=now() WHERE id=$1",[job.id,state,result.code,delay]);
    audit(job,state,result.code);
   }
  }finally{running=false;}
 }
 return {enabled,send,tick,configuration:config,async verify(){if(!enabled)throw fail('邮件服务尚未完成配置');return transport.verify();},start(){if(enabled&&!timer){timer=setInterval(()=>void tick().catch(()=>{}),intervalMs);timer.unref();}},stop(){clearInterval(timer);timer=null;}};
}
export function installMailOutboxRoutes(app,{query,mailer,now=()=>Date.now()}){
 let verifying=false,lastCheck=-Infinity;
 app.get('/api/admin/mail/status',requireManagement,async(req,res)=>{
  const counts=(await query('SELECT state,count(*)::int count FROM mail_outbox GROUP BY state')).rows;
  const lastVerification=(await query("SELECT id,action,metadata,created_at FROM operation_events WHERE action IN ('mail.configuration.verified','mail.configuration.activated') ORDER BY id DESC LIMIT 1")).rows[0]||null;
  res.json({configuration:mailer.configuration,counts,lastVerification});
 });
 app.get('/api/admin/mail/jobs',requireManagement,async(req,res)=>{
  const offset=z.coerce.number().int().min(0).max(10000).default(0).parse(req.query.offset);
  const rows=(await query('SELECT id,purpose,state,attempts,last_error,created_at,updated_at,next_at,expires_at FROM mail_outbox ORDER BY created_at DESC,id LIMIT 30 OFFSET $1',[offset])).rows;
  res.json({items:rows});
 });
 app.get('/api/admin/mail/history',requireManagement,async(req,res)=>{
  const items=(await query("SELECT id,action,resource_id,metadata,created_at FROM operation_events WHERE action LIKE 'mail.%' ORDER BY id DESC LIMIT 30")).rows;
  res.json({items});
 });
 app.post('/api/admin/mail/verify',requireManagement,async(req,res)=>{
  z.object({}).strict().parse(req.body||{});
  if(verifying||now()-lastCheck<30000)return res.status(429).json({error:'请等待30秒后再核验'});
  verifying=true;lastCheck=now();let result;
  try{
   if(!mailer.enabled)result={passed:false,code:'MAIL_NOT_CONFIGURED'};
   else try{await mailer.verify();result={passed:true};}
   catch(error){result={passed:false,code:/^SES_[A-Z_]+$/.test(error?.mailDelivery?.code)?error.mailDelivery.code:'MAIL_CHECK_FAILED'};}
   const metadata={provider:mailer.configuration.provider,...result};
   const record=(await query("INSERT INTO operation_events(user_id,kind,action,request_id,metadata) VALUES($1,'admin','mail.configuration.verified',$2,$3) RETURNING created_at",[req.user.id,req.operationRequestId||null,metadata])).rows[0];
   res.json({...metadata,checkedAt:record.created_at,messageSent:false});
  }finally{verifying=false;}
 });
}
