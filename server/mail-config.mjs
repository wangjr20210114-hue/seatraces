/* 整理邮件模板、发送配置和应用链接。 */

import {z} from 'zod';

export const mailMessage=z.object({
  to:z.email().max(254),
  purpose:z.enum(['verify_email','reset_password','password_changed']),
  token:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  messageId:z.string().max(254).regex(/^<[^\r\n<>]+>$/).optional(),
}).strict().refine(v=>v.purpose==='password_changed'||v.token);
export const sesTemplates={
  verify_email:'SES_TEMPLATE_VERIFY_EMAIL',
  reset_password:'SES_TEMPLATE_RESET_PASSWORD',
  password_changed:'SES_TEMPLATE_PASSWORD_CHANGED',
};

export function mailOrigin(value){
  const origin=new URL(value);
  if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||
    (origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['127.0.0.1','localhost'].includes(origin.hostname))))
    throw Error('APP_ORIGIN must be an HTTPS origin (loopback HTTP is allowed for development)');
  return origin;
}

export function mailTransportConfiguration(env=process.env){
  const provider=env.MAIL_PROVIDER||'smtp',ses=provider==='tencent_ses';
  const required=ses?['APP_ORIGIN','SES_REGION','SES_SECRET_ID','SES_SECRET_KEY','SES_FROM',...Object.values(sesTemplates)]
    :['SMTP_HOST','SMTP_USER','SMTP_PASSWORD','SMTP_FROM','APP_ORIGIN'];
  const missing=required.filter(k=>!env[k]),invalid=[];
  if(!['smtp','tencent_ses'].includes(provider))invalid.push('MAIL_PROVIDER');
  if(env.APP_ORIGIN)try{mailOrigin(env.APP_ORIGIN);}catch{invalid.push('APP_ORIGIN');}
  if(ses){
    if(env.SES_REGION&&!['ap-guangzhou','ap-hongkong'].includes(env.SES_REGION))invalid.push('SES_REGION');
    if(env.SES_FROM&&!z.email().max(254).safeParse(env.SES_FROM).success)invalid.push('SES_FROM');
    for(const k of Object.values(sesTemplates))if(env[k]&&(!/^[1-9]\d*$/.test(env[k])||!Number.isSafeInteger(Number(env[k]))))invalid.push(k);
    for(const k of ['SES_SECRET_ID','SES_SECRET_KEY'])if(env[k]&&/[\s\x00-\x1f]/.test(env[k]))invalid.push(k);
  }else if(env.SMTP_PORT&&!['465','587'].includes(String(env.SMTP_PORT)))invalid.push('SMTP_PORT');
  return {provider:ses?'tencent_ses':provider==='smtp'?'smtp':'unsupported',enabled:missing.length===0&&invalid.length===0,missing,invalid};
}

export function mailContent(input,origin){
  const value=mailMessage.parse(input),label=value.purpose==='verify_email'?'验证邮箱':value.purpose==='password_changed'?'密码已修改':'重设密码';
  const url=new URL('/login.html',origin);
  if(value.token)url.hash=new URLSearchParams({action:value.purpose,token:value.token}).toString();
  return {...value,subject:`SeaTraces · ${label}`,link:url.href,
    text:value.token?`请打开下面的链接${label}，链接 30 分钟内有效，使用后失效。\n\n${url.href}\n\n如果不是你本人操作，请忽略此邮件。`
      :'你的 SeaTraces 密码已经修改，原有登录会话已退出。如果不是你本人操作，请尽快使用已绑定邮箱重设密码。'};
}
