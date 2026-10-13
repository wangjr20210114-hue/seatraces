import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import pg from 'pg';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { createAccounts, hashToken } from '../server/auth.mjs';

test('PostgreSQL accounts: unique IDs, session isolation, avatar, verified recovery and one-use tokens', { skip: process.env.TEST_ACCOUNTS !== '1' }, async () => {
  const config = JSON.parse(await readFile(new URL('../.runtime/local.json', import.meta.url), 'utf8'));
  const client = new pg.Client({ host: '127.0.0.1', port: config.port, user: 'seatraces', password: config.password, database: 'seatraces' });
  const schema = 'account_test_' + randomBytes(6).toString('hex');
  let server;
  const mail = [], waiters = [];
  const mailer = { enabled: true, async send(message) { mail.push(message); waiters.splice(0).forEach(resolve => resolve()); } };
  const waitForMail = async purpose => {
    for (let i = 0; i < 50; i++) { const found = mail.find(m => m.purpose === purpose); if (found) return found; await new Promise(r => setTimeout(r, 30)); }
    throw Error('Expected test mail not delivered');
  };
  try {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`CREATE TABLE users(id uuid PRIMARY KEY,username varchar(32) UNIQUE NOT NULL,password_hash text NOT NULL,nickname varchar(40) NOT NULL,
      avatar varchar(12) NOT NULL DEFAULT '🌊',role text NOT NULL DEFAULT 'user',preferences jsonb NOT NULL DEFAULT '{"interests":[],"pace":"balanced","analyticsConsent":false}');
      CREATE TABLE sessions(token_hash text PRIMARY KEY,user_id uuid REFERENCES users(id),expires_at timestamptz);
      CREATE TABLE browse_events(user_id uuid);`);
    await client.query(await readFile(new URL('../server/auth-schema.sql', import.meta.url), 'utf8'));
    // One connection; serialize transactions so concurrent reset checks stay meaningful.
    let tail = Promise.resolve();
    const serialize = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
    const query = (sql, args) => serialize(() => client.query(sql, args));
    const transaction = fn => serialize(async () => { await client.query('BEGIN'); try { const value = await fn(client); await client.query('COMMIT'); return value; } catch (e) { await client.query('ROLLBACK'); throw e; } });
    const accounts = createAccounts({ query, transaction, mailer, production: true });
    const app = express(); app.use(express.json({ limit: '2mb' }), cookieParser(), accounts.attach, accounts.gate, accounts.router);
    app.get('/business', (req, res) => res.json({ owner: req.user.id }));
    app.use((error, req, res, next) => res.status(error.status || (error.name === 'ZodError' ? 400 : 500)).json({ error: error.message }));
    server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    function userClient(initialCookie = '') {
      let cookie = initialCookie;
      return { get cookie() { return cookie; }, async request(path, body, method) {
        const r = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const rawCookie = r.headers.get('set-cookie'); if (rawCookie) cookie = rawCookie.split(';')[0];
        const data = r.headers.get('content-type')?.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
        return { status: r.status, data, rawCookie };
      } };
    }
    const a = userClient(), b = userClient(), anon = userClient();
    const oldPassword = randomBytes(16).toString('hex'), newPassword = randomBytes(16).toString('hex');
    assert.equal((await anon.request('/business')).status, 401);
    assert.equal((await anon.request('/auth/demo', {})).status, 401);
    assert.equal((await anon.request('/auth/register', { username: 'toolong', password: '密'.repeat(25) })).status, 400);
    const registered = await a.request('/auth/register', { username: 'TravelerOne', password: oldPassword });
    assert.equal(registered.status, 200); assert.equal(registered.data.user.username, 'travelerone'); assert.equal(registered.data.user.role, 'user');
    assert.match(registered.rawCookie, /HttpOnly/); assert.match(registered.rawCookie, /SameSite=Strict/); assert.match(registered.rawCookie, /Secure/);
    const duplicate = await b.request('/auth/register', { username: 'TRAVELERONE', password: oldPassword }); assert.equal(duplicate.status, 409);
    await b.request('/auth/register', { username: 'traveler_two', password: oldPassword });
    const stored = (await query('SELECT password_hash FROM users WHERE id=$1', [registered.data.user.id])).rows[0];
    assert.notEqual(stored.password_hash, oldPassword);
    assert.equal((await query('SELECT 1 FROM sessions WHERE token_hash=$1', [a.cookie.split('=')[1]])).rowCount, 0);
    assert.equal((await a.request('/me', { nickname: '自己的昵称', username: 'changed' }, 'PATCH')).status, 400);
    assert.equal((await a.request('/me', { nickname: '自己的昵称', avatar: '🧭' }, 'PATCH')).status, 200);
    assert.equal((await b.request('/me')).data.user.nickname, 'traveler_two');
    // A pre-upgrade preference cannot switch off recommendations or delete recorded views.
    await query(`UPDATE users SET preferences=preferences || '{"analyticsConsent":false}'::jsonb WHERE id=$1`, [registered.data.user.id]);
    assert.equal((await a.request('/me')).data.user.preferences.analyticsConsent, undefined);
    await query('INSERT INTO browse_events(user_id) VALUES($1)', [registered.data.user.id]);
    const preferenceUpdate = await a.request('/me', { preferences: { interests: ['自然'], pace: 'relaxed', analyticsConsent: false } }, 'PATCH');
    assert.equal(preferenceUpdate.status, 200);
    assert.deepEqual(preferenceUpdate.data.user.preferences, { interests: ['自然'], pace: 'relaxed' });
    assert.equal((await query('SELECT count(*)::int n FROM browse_events WHERE user_id=$1', [registered.data.user.id])).rows[0].n, 1);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#23cabb' } }).png().toBuffer();
    assert.equal((await a.request('/me/avatar', { image: 'data:image/png;base64,' + png.toString('base64') }, 'PUT')).status, 200);
    assert.equal((await a.request('/me/avatar')).status, 200); assert.equal((await b.request('/me/avatar')).status, 404);
    assert.equal((await a.request('/me/avatar', { image: 'data:image/png;base64,YWJj' }, 'PUT')).status, 400);
    const originalCookie = a.cookie;
    const guestId = randomUUID(), guestToken = randomBytes(32).toString('hex');
    await query("INSERT INTO users(id,username,password_hash,nickname,role) VALUES($1,'demo_abcdef12',$2,'海迹体验者','admin')", [guestId, stored.password_hash]);
    await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [hashToken(guestToken), guestId]);
    const guest = userClient('st_session=' + guestToken);
    assert.equal((await guest.request('/business')).status, 401);
    assert.equal((await guest.request('/me')).data.guestAvailable, true);
    const claimed = await guest.request('/auth/register', { username: 'claimed_traveler', password: newPassword, claimGuest: true });
    assert.equal(claimed.status, 200); assert.equal(claimed.data.user.id, guestId); assert.equal(claimed.data.user.role, 'user');
    assert.equal((await fetch(base + '/business', { headers: { Cookie: 'st_session=' + guestToken } })).status, 401);
    assert.equal((await a.request('/auth/email/request', { email: 'person@example.test', password: oldPassword })).status, 200);
    assert.equal((await query('SELECT count(*)::int n FROM user_emails')).rows[0].n, 0);
    const verify = await waitForMail('verify_email');
    assert.equal((await anon.request('/auth/verify-email', { token: verify.token })).status, 200);
    assert.equal((await anon.request('/auth/verify-email', { token: verify.token })).status, 400);
    const unknown = await anon.request('/auth/forgot-password', { email: 'unknown@example.test' });
    const known = await anon.request('/auth/forgot-password', { email: 'person@example.test' });
    assert.deepEqual(known, unknown);
    const reset = await waitForMail('reset_password');
    assert.equal((await query('SELECT 1 FROM account_tokens WHERE token_hash=$1', [reset.token])).rowCount, 0);
    const resetResults = await Promise.all([anon.request('/auth/reset-password', { token: reset.token, password: newPassword }), anon.request('/auth/reset-password', { token: reset.token, password: newPassword })]);
    assert.deepEqual(resetResults.map(r => r.status).sort(), [200,400]);
    assert.equal((await a.request('/business')).status, 401);
    assert.equal((await anon.request('/auth/login', { username: 'TravelerOne', password: oldPassword })).status, 401);
    assert.equal((await a.request('/auth/login', { username: 'TRAVELERONE', password: newPassword })).status, 200);
    assert.notEqual(a.cookie, originalCookie);
    const expired = randomBytes(32).toString('hex');
    await query(`INSERT INTO account_tokens(token_hash,user_id,purpose,email,expires_at) VALUES($1,$2,'reset_password','person@example.test',now()-interval '1 minute')`, [hashToken(expired), registered.data.user.id]);
    assert.equal((await anon.request('/auth/reset-password', { token: expired, password: oldPassword })).status, 400);
    const logoutCookie = a.cookie;
    assert.equal((await a.request('/auth/logout', {})).status, 200);
    const replay = await fetch(base + '/business', { headers: { Cookie: logoutCookie } }); assert.equal(replay.status, 401);
    const noMail = createAccounts({ query, transaction, mailer: { enabled: false } });
    const offApp = express(); offApp.use(express.json(), noMail.router); offApp.use((e, req, res, next) => res.status(e.status || 500).end());
    const off = offApp.listen(0, '127.0.0.1'); await new Promise(r => off.once('listening', r));
    try { assert.equal((await fetch('http://127.0.0.1:' + off.address().port + '/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'person@example.test' }) })).status, 503); }
    finally { await new Promise(r => off.close(r)); }
  } finally {
    if (server) await new Promise(r => server.close(r));
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
