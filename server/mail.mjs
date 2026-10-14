import nodemailer from 'nodemailer';

export function createMailer(env = process.env) {
  const configured = ['SMTP_HOST','SMTP_USER','SMTP_PASSWORD','SMTP_FROM','APP_ORIGIN'].every(k => !!env[k]);
  if (!configured) return { enabled: false };
  const origin = new URL(env.APP_ORIGIN);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1','localhost'].includes(origin.hostname))))
    throw Error('APP_ORIGIN must be an HTTPS origin (loopback HTTP is allowed for development)');
  const port = Number(env.SMTP_PORT || 465);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port, secure: port === 465, requireTLS: port !== 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return {
    enabled: true,
    async send({ to, purpose, token }) {
      const label = purpose === 'verify_email' ? '验证邮箱' : purpose === 'password_changed' ? '密码已修改' : '重设密码';
      // Fragment tokens never enter HTTP access logs or Referer headers.
      const url = new URL('/login.html', origin);
      if (token) url.hash = new URLSearchParams({ action: purpose, token }).toString();
      await transport.sendMail({
        from: env.SMTP_FROM, to, subject: `SeaTraces · ${label}`,
        text: token ? `请打开下面的链接${label}，链接 30 分钟内有效，使用后失效。\n\n${url.href}\n\n如果不是你本人操作，请忽略此邮件。`
          : '你的 SeaTraces 密码已经修改，原有登录会话已退出。如果不是你本人操作，请尽快使用已绑定邮箱重设密码。',
      });
    },
  };
}
