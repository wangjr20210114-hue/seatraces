import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import express from 'express';
import { orderWalk, routeMetres } from '../public/citywalk-route.js';
import { selectedWalk, installCityWalkRoutes } from '../server/services/citywalk-service.mjs';

const points = [{ id: 'a', name: 'A', lat: 31, lng: 121 }, { id: 'b', name: 'B', lat: 31.01, lng: 121.01 }, { id: 'c', name: 'C', lat: 31, lng: 121.01 }, { id: 'd', name: 'D', lat: 31.01, lng: 121 }];
const city = { id: 'city-test', name: '测试城市', country: 'CN', lat: 31, lng: 121 };
const catalog = { clusters: [{ id: 'area', members: points }] };
test('CityWalk ordering keeps every selected sight and chosen start while shortening a crossing route', () => {
  const ordered = orderWalk(points, 'a');
  assert.equal(ordered[0].id, 'a'); assert.equal(new Set(ordered.map(p => p.id)).size, 4);
  assert.ok(routeMetres(ordered) < routeMetres(points));
  const fromB = orderWalk(points, 'b'); assert.equal(fromB[0].id, 'b');
  assert.equal(orderWalk([...points, points[0]]).length, 4);
  assert.throws(() => orderWalk([{ id: 'bad', lat: NaN, lng: 1 }]));
});
test('CityWalk selection rejects invented IDs and out-of-scope sights; uses server coordinates', () => {
  const input = { clusterIds: ['area'], stopIds: ['a', 'b'], startId: 'a' };
  assert.equal(selectedWalk({ city, catalog }, input)[0].lat, 31);
  assert.throws(() => selectedWalk({ city, catalog }, { ...input, stopIds: ['a', 'fake'] }));
  assert.throws(() => selectedWalk({ city, catalog }, { ...input, clusterIds: ['fake'] }));
  assert.throws(() => selectedWalk({ city, catalog }, { ...input, stopIds: ['a', 'a'] }));
});
test('PostgreSQL CityWalk: async catalog, persist, ownership, editing, conflicts and retry', { skip: process.env.TEST_CITYWALK !== '1' }, async () => {
  const config = JSON.parse(await readFile(new URL('../.runtime/local.json', import.meta.url), 'utf8'));
  const client = new pg.Client({ host: '127.0.0.1', port: config.port, user: 'seatraces', password: config.password, database: 'seatraces' });
  const schema = 'citywalk_test_' + randomBytes(6).toString('hex'), a = randomUUID(), b = randomUUID(); let server;
  try {
    await client.connect(); await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path TO ${schema}`);
    await client.query('CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE places(id text,name text,country text,province text,lat double precision,lng double precision,timezone text,category text)');
    await client.query('INSERT INTO users VALUES($1),($2)', [a, b]);
    await client.query("INSERT INTO places VALUES($1,$2,'CN','',31,121,'Asia/Shanghai','city')", [city.id, city.name]);
    await client.query(await readFile(new URL('../server/citywalk-schema.sql', import.meta.url), 'utf8'));
    const app = express(); app.use(express.json());
    const auth = (req, res, next) => { const id = req.headers['x-test-owner']; if (![a, b].includes(id)) return res.sendStatus(401); req.user = { id }; next(); };
    installCityWalkRoutes(app, { auth, travelHabit: () => ({}), query: (sql, args) => client.query(sql, args), loadCity: async c => ({ city: c, ...catalog }) });
    app.use((e, req, res, next) => res.status(e.status || (e.name === 'ZodError' ? 400 : 500)).json({ error: e.message }));
    server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = async (path, body, owner = a, method) => { const r = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', 'x-test-owner': owner }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, data: r.headers.get('content-type')?.includes('json') ? await r.json() : null }; };
    assert.equal((await request('/api/citywalks', null, '')).status, 401);
    let draft;
    for (let i = 0; i < 30; i++) { const r = await request('/api/citywalk/catalog/' + city.id); if (r.status === 200) { draft = r.data; break; } await new Promise(r => setTimeout(r, 10)); }
    assert.ok(draft?.draftId);
    const input = { id: randomUUID(), draftId: draft.draftId, title: '我的路线', clusterIds: ['area'], stopIds: ['a', 'b', 'c', 'd'], startId: 'a' };
    assert.equal((await request('/api/citywalks', input, b)).status, 410);
    const created = await request('/api/citywalks', input); assert.equal(created.status, 200); assert.equal(created.data.stops.length, 4);
    assert.equal((await request('/api/citywalks/' + input.id, null, b)).status, 404);
    const updated = await request('/api/citywalks/' + input.id, { ...input, title: '重新编辑', startId: 'c', version: 1 }, a, 'PUT');
    assert.equal(updated.status, 200); assert.equal(updated.data.version, 2); assert.equal(updated.data.stops[0].id, 'c');
    assert.equal((await request('/api/citywalks/' + input.id, { ...input, version: 1 }, a, 'PUT')).status, 409);
    assert.equal((await request('/api/citywalks', input)).status, 200);
    assert.equal((await request('/api/citywalks')).data.length, 1);
    assert.equal((await request('/api/citywalks/' + input.id)).data.title, '重新编辑');
    await client.query('UPDATE citywalk_drafts SET expires_at=now()-interval \'1 second\' WHERE id=$1', [draft.draftId]);
    assert.equal((await request('/api/citywalks', { ...input, id: randomUUID() })).status, 410);
    assert.equal((await request('/api/citywalks', null, b)).data.length, 0);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    await client.query('SET search_path TO public').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await client.end();
  }
});
