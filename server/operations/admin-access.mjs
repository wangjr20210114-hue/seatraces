import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { hashToken } from '../auth.mjs';
import {managementAccess,authorizeManagement} from './permissions.mjs';

const sessionMinutes = 30;
const validToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
// Domain separation prevents an ordinary app cookie from becoming an admin
// session simply by changing its cookie name. Existing sessions remain valid.
export const adminTokenHash = token => hashToken('admin-session:' + token);
const dummyHash = bcrypt.hash(randomBytes(32).toString('hex'), 12);
const allowed = user => !!managementAccess(user);
const memberColumns='m.role management_role,m.enabled management_enabled,m.version management_version';
const failure = (status, message) => Object.assign(Error(message), { status });
const safeUser = user => ({ id: user.id, username: user.username, nickname: user.nickname, role: user.role });
const pageFile = fileURLToPath(new URL('./admin.html', import.meta.url));

export function installAdminAccess(app, { query, transaction, production = false }) {
  const cookie = { httpOnly: true, sameSite: 'strict', secure: production, path: '/' };
  async function attach(req, res, next) {
    // Never inherit the application session for management requests.
    req.applicationUser = req.user;
    req.user = undefined;
    req.adminAccess = undefined;
    res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    try {
      const token = req.cookies?.st_admin;
      if (validToken(token)) {
        const user = (await query(`SELECT u.*,${memberColumns},s.expires_at admin_expires_at,s.admin_access_version FROM users u JOIN sessions s ON s.user_id=u.id
          LEFT JOIN admin_memberships m ON m.user_id=u.id
          WHERE s.token_hash=$1 AND s.expires_at>now()`, [adminTokenHash(token)])).rows[0];
        if (allowed(user) && (user.role==='admin'||user.admin_access_version===user.management_version)) {
          req.user = user;req.adminAccess=managementAccess(user);
        }
        else res.clearCookie('st_admin', cookie);
      }
      next();
    } catch (error) { next(error); }
  }
  function sourceCheck(req, res, next) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        (req.get('X-Seatraces') !== '1' || req.get('Sec-Fetch-Site') === 'cross-site'))
      return res.status(403).json({ error: '请求来源校验失败' });
    next();
  }
  function requireSession(req, res, next) {
    if (!req.user && req.applicationUser && req.applicationUser.role !== 'admin')
      return res.status(403).json({ error: '需要管理员权限' });
    if (!allowed(req.user)) return res.status(401).json({ error: '请登录管理后台', code: 'admin_login_required' });
    next();
  }
  app.use('/api/auth/admin', sourceCheck);
  app.post('/api/auth/admin/login', async (req, res) => {
    const b = z.object({ username: z.string().trim().regex(/^[a-zA-Z0-9_]{3,32}$/).transform(s => s.toLowerCase()),
      password: z.string().min(8).refine(s => Buffer.byteLength(s, 'utf8') <= 72) }).strict().parse(req.body);
    // Share the account lockout with ordinary login; switching endpoints must
    // not double the password guessing allowance.
    const limitKey = hashToken('login:' + b.username);
    const rate = (await query(`INSERT INTO auth_rate_limits(key_hash,hits,until) VALUES($1,1,now()+interval '600 seconds')
      ON CONFLICT(key_hash) DO UPDATE SET hits=CASE WHEN auth_rate_limits.until<=now() THEN 1 ELSE auth_rate_limits.hits+1 END,
      until=CASE WHEN auth_rate_limits.until<=now() THEN excluded.until ELSE auth_rate_limits.until END RETURNING hits`, [limitKey])).rows[0];
    if (rate.hits > 10) throw failure(429, '操作太频繁，请稍后再试');
    const user = (await query(`SELECT u.*,${memberColumns} FROM users u LEFT JOIN admin_memberships m ON m.user_id=u.id WHERE lower(u.username)=$1`, [b.username])).rows[0];
    const matches = await bcrypt.compare(b.password, user?.password_hash || await dummyHash);
    if (!matches || !allowed(user)) throw failure(401, '管理员账号或密码不正确');
    const token = randomBytes(32).toString('hex');
    const expiresAt = await transaction(async c => {
      const current = (await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [user.id])).rows[0];
      const membership=(await c.query('SELECT role management_role,enabled management_enabled,version management_version FROM admin_memberships WHERE user_id=$1',[user.id])).rows[0];
      Object.assign(current,membership);
      if (!allowed(current) || current.password_hash !== user.password_hash) throw failure(401, '账号状态已变更，请重新登录');
      if (validToken(req.cookies?.st_admin)) await c.query('DELETE FROM sessions WHERE token_hash=$1', [adminTokenHash(req.cookies.st_admin)]);
      const result = await c.query(`INSERT INTO sessions(token_hash,user_id,expires_at,admin_access_version) VALUES($1,$2,now()+interval '30 minutes',$3) RETURNING expires_at`, [adminTokenHash(token), user.id,managementAccess(current).version]);
      return result.rows[0].expires_at;
    });
    await query('DELETE FROM auth_rate_limits WHERE key_hash=$1', [limitKey]);
    req.auditUserId = user.id;
    res.set('Cache-Control', 'no-store').cookie('st_admin', token, { ...cookie, maxAge: sessionMinutes * 60000 })
      .json({ user: safeUser(user), expiresAt });
  });
  app.get('/api/auth/admin/me', attach, (req, res) => res.json({ user: req.user ? safeUser(req.user) : null, access:req.adminAccess||null, expiresAt: req.user?.admin_expires_at || null }));
  app.post('/api/auth/admin/logout', attach, async (req, res) => {
    if (validToken(req.cookies?.st_admin)) await query('DELETE FROM sessions WHERE token_hash=$1', [adminTokenHash(req.cookies.st_admin)]);
    res.clearCookie('st_admin', cookie).json({ ok: true });
  });
  // All current and future admin endpoints must pass the same server-side gate.
  app.use('/api/admin', attach, sourceCheck, requireSession,authorizeManagement);
  app.get(['/admin', '/admin.html'], attach, (req, res) => {
    if (!allowed(req.user)) return res.redirect(302, '/admin-login.html');
    res.sendFile(pageFile, { cacheControl: false, lastModified: false, etag: false });
  });
}
