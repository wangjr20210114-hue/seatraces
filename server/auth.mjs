/* 管理账号注册、登录、会话和个人资料。 */

import express from 'express';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { interests } from './planner.mjs';
import {guestApiRead} from '../public/guest-policy.js';

export const hashToken = value => createHash('sha256').update(value).digest('hex');
const account = z.string().trim().regex(/^[a-zA-Z0-9_]{3,32}$/).transform(s => s.toLowerCase());
const password = z.string().min(8).refine(s => Buffer.byteLength(s, 'utf8') <= 72, '密码最多 72 个 UTF-8 字节');
const email = z.string().trim().toLowerCase().email().max(254);
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const avatars = ['🌊','🌿','🧭','🌸','🏔️','☀️'];
const preferences = z.object({ interests: z.array(z.enum(interests)).max(10), pace: z.enum(['relaxed','balanced','full']) });
const currentPreferences = value => {
  const { analyticsConsent: legacyChoice, ...rest } = value || {};
  return rest;
};
const failure = (status, message) => Object.assign(Error(message), { status });
const dummyHash = bcrypt.hash(randomBytes(32).toString('hex'), 12);
const isLegacyGuest = u => u?.role === 'admin' && /^demo_[a-f0-9]{8}$/.test(u.username);
export const requireUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: '请先登录', code: 'login_required' });
export const publicUser = u => ({ id: u.id, username: u.username, nickname: u.nickname, avatar: u.avatar,
  avatarUrl: u.avatar_updated_at ? '/api/me/avatar?v=' + new Date(u.avatar_updated_at).getTime() : null,
  email: u.email || null, emailVerified: !!u.email, role: u.role, preferences: currentPreferences(u.preferences) });

export function createAccounts({ query, transaction, production = false, mailer = { enabled: false } }) {
  const router = express.Router();
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: production, path: '/' };
  const userSql = `SELECT u.*,e.email,a.updated_at avatar_updated_at FROM users u
    LEFT JOIN user_emails e ON e.user_id=u.id LEFT JOIN user_avatars a ON a.user_id=u.id`;
  const userById = async id => (await query(userSql + ' WHERE u.id=$1', [id])).rows[0];
  async function attach(req, res, next) {
    try {
      const token = req.cookies?.st_session;
      if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) {
        req.user = (await query(userSql + ` JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()`, [hashToken(token)])).rows[0];
        if (!req.user) res.clearCookie('st_session', cookieOptions);
        if (req.user?.disabled_at || req.user?.is_synthetic) { req.user=undefined; res.clearCookie('st_session',cookieOptions); }
        if (isLegacyGuest(req.user)) { req.guest = req.user; req.user = undefined; }
        if (req.user) req.user.preferences = currentPreferences(req.user.preferences);
      }
      next();
    } catch (e) { next(e); }
  }
  async function throttle(key, limit = 5, seconds = 900) {
    const { rows } = await query(`INSERT INTO auth_rate_limits(key_hash,hits,until) VALUES($1,1,now()+$2*interval '1 second')
      ON CONFLICT(key_hash) DO UPDATE SET hits=CASE WHEN auth_rate_limits.until<=now() THEN 1 ELSE auth_rate_limits.hits+1 END,
      until=CASE WHEN auth_rate_limits.until<=now() THEN excluded.until ELSE auth_rate_limits.until END RETURNING hits`, [hashToken(key), seconds]);
    if (rows[0].hits > limit) throw failure(429, '操作太频繁，请稍后再试');
  }
  async function newSession(c, req, userId) {
    const token = randomBytes(32).toString('hex');
    if (typeof req.cookies?.st_session === 'string') await c.query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(req.cookies.st_session)]);
    await c.query(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '14 days')`, [hashToken(token), userId]);
    return token;
  }
  const setSession = (res, token) => res.cookie('st_session', token, { ...cookieOptions, maxAge: 14 * 86400000 });
  const requireMail = () => { if (!mailer.enabled) throw failure(503, '邮箱服务尚未配置，请稍后再试'); };
  async function issueToken(userId, purpose, address) {
    const token = randomBytes(32).toString('hex');
    await transaction(async c => {
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      await c.query('DELETE FROM account_tokens WHERE user_id=$1 AND purpose=$2', [userId, purpose]);
      await c.query(`INSERT INTO account_tokens(token_hash,user_id,purpose,email,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 minutes')`, [hashToken(token), userId, purpose, address]);
    });
    try { await mailer.send({ to: address, purpose, token }); }
    catch { await query('DELETE FROM account_tokens WHERE token_hash=$1', [hashToken(token)]); throw failure(503, '邮件暂时发送失败，请稍后再试'); }
  }
  async function useToken(token, purpose, callback) {
    const digest = hashToken(tokenSchema.parse(token));
    const candidate = (await query('SELECT user_id FROM account_tokens WHERE token_hash=$1 AND purpose=$2', [digest, purpose])).rows[0];
    if (!candidate) throw failure(400, '链接已过期或已使用，请重新申请');
    return transaction(async c => {
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [candidate.user_id]);
      const t = (await c.query(`SELECT * FROM account_tokens WHERE token_hash=$1 AND purpose=$2 AND used_at IS NULL AND expires_at>now() FOR UPDATE`, [digest, purpose])).rows[0];
      if (!t) throw failure(400, '链接已过期或已使用，请重新申请');
      await callback(c, t);
      await c.query('UPDATE account_tokens SET used_at=now() WHERE token_hash=$1', [digest]);
    });
  }
  router.get('/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null, guestAvailable: !!req.guest }));
  router.get('/auth/config', (req, res) => res.json({ emailEnabled: mailer.enabled }));
  router.post('/auth/register', async (req, res) => {
    const b = z.object({ username: account, password, nickname: z.string().trim().min(1).max(40).optional(), claimGuest: z.boolean().optional() }).parse(req.body);
    const claim = b.claimGuest && req.guest;
    const id = claim ? req.guest.id : randomUUID();
    const digest = await bcrypt.hash(b.password, 12);
    try {
      const token = await transaction(async c => {
        if (claim) {
          const previous = (await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
          const session = await c.query('SELECT 1 FROM sessions WHERE user_id=$1 AND token_hash=$2 AND expires_at>now()', [id, hashToken(req.cookies.st_session)]);
          if (!isLegacyGuest(previous) || !session.rowCount) throw failure(409, '体验记录已被接收，请刷新后重试');
          await c.query("UPDATE users SET username=$1,password_hash=$2,nickname=$3,role='user',password_changed_at=now() WHERE id=$4", [b.username, digest, b.nickname || b.username, id]);
          await c.query('DELETE FROM sessions WHERE user_id=$1', [id]);
        } else {
          await c.query('INSERT INTO users(id,username,password_hash,nickname) VALUES($1,$2,$3,$4)', [id, b.username, digest, b.nickname || b.username]);
        }
        return newSession(c, req, id);
      });
      setSession(res, token);
    } catch (e) { if (e.code === '23505') throw failure(409, '这个账号名已被使用'); throw e; }
    res.json({ user: publicUser(await userById(id)) });
  });
  router.post('/auth/login', async (req, res) => {
    const b = z.object({ username: account, password }).parse(req.body);
    await throttle('login:' + b.username, 10, 600);
    const u = (await query('SELECT * FROM users WHERE lower(username)=$1', [b.username])).rows[0];
    const matches = await bcrypt.compare(b.password, u&&!u.is_synthetic?u.password_hash:await dummyHash);
    if (!u || !matches || isLegacyGuest(u) || u.is_synthetic) throw failure(401, '账号或密码不正确');
    if(u.disabled_at) throw failure(403,'账号已停用，请联系管理员');
    const token = await transaction(async c => {
      const locked = (await c.query('SELECT password_hash,disabled_at FROM users WHERE id=$1 FOR UPDATE', [u.id])).rows[0];
      if(locked?.disabled_at) throw failure(403,'账号已停用，请联系管理员');
      if (locked.password_hash !== u.password_hash) throw failure(401, '密码已变更，请重新登录');
      return newSession(c, req, u.id);
    });
    await query('DELETE FROM auth_rate_limits WHERE key_hash=$1', [hashToken('login:' + b.username)]);
    req.auditUserId=u.id;
    setSession(res, token);
    res.json({ user: publicUser(await userById(u.id)) });
  });
  router.post('/auth/logout', async (req, res) => {
    if (typeof req.cookies?.st_session === 'string') await query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(req.cookies.st_session)]);
    res.clearCookie('st_session', cookieOptions).json({ ok: true });
  });
  router.post('/auth/forgot-password', async (req, res) => {
    const b = z.object({ email }).parse(req.body);
    requireMail();
    await throttle('reset:' + b.email, 3, 900);
    res.status(202).json({ message: '若该邮箱已验证绑定，重设密码邮件会发到收件箱。' });
    void (async () => {
      const u = (await query('SELECT user_id FROM user_emails WHERE email=$1', [b.email])).rows[0];
      if (u) await issueToken(u.user_id, 'reset_password', b.email);
    })().catch(() => console.error('Account recovery email could not be delivered'));
  });
  router.post('/auth/reset-password', async (req, res) => {
    const b = z.object({ token: tokenSchema, password }).parse(req.body);
    const digest = await bcrypt.hash(b.password, 12);
    let address;
    await useToken(b.token, 'reset_password', async (c, t) => {
      const bound = (await c.query('SELECT email FROM user_emails WHERE user_id=$1', [t.user_id])).rows[0];
      if (bound?.email !== t.email) throw failure(400, '绑定邮箱已变更，请重新申请');
      address = t.email;
      await c.query('UPDATE users SET password_hash=$1,password_changed_at=now() WHERE id=$2', [digest, t.user_id]);
      await c.query('DELETE FROM sessions WHERE user_id=$1', [t.user_id]);
      await c.query('UPDATE account_tokens SET used_at=now() WHERE user_id=$1', [t.user_id]);
    });
    res.clearCookie('st_session', cookieOptions).json({ ok: true, message: '密码已更新，请重新登录。' });
    if (mailer.enabled) void mailer.send({ to: address, purpose: 'password_changed' }).catch(() => console.error('Password notification could not be delivered'));
  });
  router.post('/auth/email/request', requireUser, async (req, res) => {
    const b = z.object({ email, password }).parse(req.body);
    requireMail();
    await throttle('bind:' + req.user.id, 3, 900);
    await throttle('bind-email:' + b.email, 3, 900);
    if (!(await bcrypt.compare(b.password, req.user.password_hash))) throw failure(400, '当前密码不正确');
    if (req.user.email) throw failure(409, '已有验证邮箱；更换邮箱功能将在后续开放');
    if ((await query('SELECT 1 FROM user_emails WHERE email=$1', [b.email])).rowCount) throw failure(409, '暂时无法绑定该邮箱');
    await issueToken(req.user.id, 'verify_email', b.email);
    res.json({ message: '验证邮件已发出，请在 30 分钟内确认。' });
  });
  router.post('/auth/verify-email', async (req, res) => {
    const b = z.object({ token: tokenSchema }).parse(req.body);
    try {
      await useToken(b.token, 'verify_email', async (c, t) => {
        await c.query('INSERT INTO user_emails(user_id,email) VALUES($1,$2)', [t.user_id, t.email]);
      });
    } catch (e) { if (e.code === '23505') throw failure(409, '邮箱已绑定或链接已失效'); throw e; }
    res.json({ ok: true, message: '邮箱已验证，以后可以用它找回密码。' });
  });
  router.patch('/me', requireUser, async (req, res) => {
    const b = z.object({ nickname: z.string().trim().min(1).max(40).optional(), avatar: z.enum(avatars).optional(), preferences: preferences.optional() }).strict().parse(req.body);
    await transaction(async c => {
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
      if (b.nickname) await c.query('UPDATE users SET nickname=$1 WHERE id=$2', [b.nickname, req.user.id]);
      if (b.avatar) {
        await c.query('UPDATE users SET avatar=$1 WHERE id=$2', [b.avatar, req.user.id]);
        await c.query('DELETE FROM user_avatars WHERE user_id=$1', [req.user.id]);
      }
      if (b.preferences) {
        await c.query('UPDATE users SET preferences=$1 WHERE id=$2', [JSON.stringify(b.preferences), req.user.id]);
      }
    });
    res.json({ user: publicUser(await userById(req.user.id)) });
  });
  router.get('/me/security', requireUser, async(req,res)=>{
    const row=(await query('SELECT count(*)::int active FROM sessions WHERE user_id=$1 AND expires_at>now()',[req.user.id])).rows[0];
    res.json({activeSessions:row.active,passwordChangedAt:req.user.password_changed_at||null,emailVerified:!!req.user.email});
  });
  router.post('/auth/change-password', requireUser, async(req,res)=>{
    const b=z.object({currentPassword:password,newPassword:password}).strict().parse(req.body);
    await throttle('change-password:'+req.user.id);
    if(b.currentPassword===b.newPassword)throw failure(400,'新密码不能与旧密码相同');
    const digest=await bcrypt.hash(b.newPassword,12);
    const token=await transaction(async c=>{
      const u=(await c.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0];
      if(!u||!await bcrypt.compare(b.currentPassword,u.password_hash))throw failure(400,'当前密码不正确');
      await c.query('UPDATE users SET password_hash=$1,password_changed_at=now() WHERE id=$2',[digest,req.user.id]);
      await c.query('DELETE FROM sessions WHERE user_id=$1',[req.user.id]);
      await c.query('DELETE FROM account_tokens WHERE user_id=$1',[req.user.id]);
      return newSession(c,req,req.user.id);
    });
    setSession(res,token);res.json({ok:true});
  });
  router.post('/auth/revoke-other-sessions',requireUser,async(req,res)=>{
    const b=z.object({password}).strict().parse(req.body);
    await throttle('revoke-sessions:'+req.user.id);
    await transaction(async c=>{
      const u=(await c.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0];
      if(!u||!await bcrypt.compare(b.password,u.password_hash))throw failure(400,'当前密码不正确');
      await c.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2',[req.user.id,hashToken(req.cookies.st_session)]);
    });res.json({ok:true});
  });
  router.put('/me/avatar', requireUser, async (req, res) => {
    const b = z.object({ image: z.string().max(1500000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/) }).parse(req.body);
    let image;
    try {
      const source = sharp(Buffer.from(b.image.split(',')[1], 'base64'), { limitInputPixels: 16000000, animated: false });
      const info = await source.metadata();
      if (!['jpeg','png','webp'].includes(info.format) || (info.pages || 1) > 1) throw Error('format');
      image = await source.rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
    } catch { throw failure(400, '请选择静态 PNG、JPG 或 WebP 图片（不超过 1600 万像素）'); }
    await query(`INSERT INTO user_avatars(user_id,image) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET image=excluded.image,updated_at=now()`, [req.user.id, image]);
    res.json({ user: publicUser(await userById(req.user.id)) });
  });
  router.get('/me/avatar', requireUser, async (req, res) => {
    const row = (await query('SELECT image FROM user_avatars WHERE user_id=$1', [req.user.id])).rows[0];
    if (!row) return res.status(404).end();
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).send(row.image);
  });
  const publicPaths = new Set(['/health','/me','/auth/config','/auth/login','/auth/register','/auth/logout','/auth/forgot-password','/auth/reset-password','/auth/verify-email']);
  function gate(req, res, next) {
    if (publicPaths.has(req.path)) return next();
    if (guestApiRead(req.path,req.method)) return next();
    return requireUser(req, res, next);
  }
  return { router, attach, gate };
}
