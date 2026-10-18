import nodemailer from 'nodemailer';
import {mailTransportConfiguration,mailOrigin,mailContent} from './mail-config.mjs';
import {createSesMailer} from './tencent-ses.mjs';

export function createMailer(env = process.env, dependencies = {}) {
  const config=mailTransportConfiguration(env);
  if (!config.enabled) return { enabled: false,provider:config.provider };
  if(config.provider==='tencent_ses')return createSesMailer(env,dependencies);
  const origin = mailOrigin(env.APP_ORIGIN);
  const port = Number(env.SMTP_PORT || 465);
  const transport = (dependencies.createTransport||nodemailer.createTransport)({
    host: env.SMTP_HOST, port, secure: port === 465, requireTLS: port !== 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return {
    enabled: true,
    provider: 'smtp',
    verify:()=>transport.verify(),
    async send(input) {
      const {to,subject,text,messageId}=mailContent(input,origin);
      const info=await transport.sendMail({
        from: env.SMTP_FROM, to, subject,
        ...(messageId?{messageId}:{}),
        text,
      });
      if(!info.accepted?.length)throw Object.assign(Error('SMTP rejected recipient'),{responseCode:550});
      return {accepted:true};
    },
  };
}
