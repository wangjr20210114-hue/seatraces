/* 验证双塔模型的语义输入。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { cachedEmbedding, temporalSemantics, profileText, week, combine, normalize, digest, semanticSpec } from '../scripts/lib/offline-semantic.mjs';
import { createMLP, lossAndDeltas, forward, trainMLP, mlpScore } from '../scripts/lib/offline-mlp.mjs';
import { validateTower } from '../server/recommendation/model.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const unit = i => Array.from({ length: 512 }, (_, j) => Number(i === j));

test('semantic CLI rejects real-data and activation arguments before opening a database', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/experiment-semantic-recommendation.mjs', import.meta.url)), '--local', '--real', '--activate'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Only --local is accepted/);
});

test('semantic cache reuses exact input and model config, rejects corruption and invalid encoder output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seatraces-semantic-')); let calls = 0;
  const encode = async () => { calls++; return unit(0); };
  try {
    assert.equal((await cachedEmbedding(dir, '园林', encode)).hit, false);
    assert.equal((await cachedEmbedding(dir, '园林', encode)).hit, true); assert.equal(calls, 1);
    await cachedEmbedding(dir, '博物馆', encode); assert.equal(calls, 2);
    const key = digest({ semanticSpec, text: '园林' }), path = join(dir, key + '.json');
    await writeFile(path, JSON.stringify({ key, vector: [1] }));
    assert.equal((await cachedEmbedding(dir, '园林', encode)).hit, false); assert.equal(calls, 3);
    const record = JSON.parse(await readFile(path)); assert.equal(record.vector.length, 512); assert.equal(record.text, undefined);
    await assert.rejects(cachedEmbedding(dir, '错误', async () => unit(0).map(() => 0)), /Invalid/);
  } finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'seatraces-semantic-'));
    await rm(dir, { recursive: true, force: true });
  }
});

test('temporal semantic features cannot observe current or immature future labels', () => {
  const vector = Array(96).fill(0); vector[0] = 1;
  const rows = [0, 1, 7, 8, 45].map((day, i) => ({ at: day * 86400000, userId: 'u', postId: String(i), label: 1, weight: 3, user: vector }));
  const items = new Map(rows.map(r => [r.postId, unit(1)])), queries = new Map([[profileText(vector), unit(0)]]);
  const first = temporalSemantics(rows, items, queries);
  assert.equal(first.get(rows[0]).historyCount, 0); assert.equal(first.get(rows[1]).historyCount, 0);
  assert.equal(first.get(rows[2]).historyCount, 0); assert.equal(first.get(rows[3]).historyCount, 1);
  assert.ok(first.get(rows[3]).latestHistoryWindowEnd < rows[3].at); assert.equal(first.get(rows[4]).historyCount, 0);
  rows[3].label = 0;
  const second = temporalSemantics(rows, items, queries);
  for (const row of rows.slice(0, 4)) assert.deepEqual(second.get(row), first.get(row));
  const joined = combine(vector, unit(0)); assert.equal(joined.length, 608); assert.ok(Math.abs(Math.hypot(...joined) - 1) < 1e-12);
});

test('two-layer normalized tower analytic gradient agrees with finite differences in both towers', () => {
  const m = createMLP(2, 4, 2), sample = { user: [.7, -.2], item: [-.1, .8], label: 1, weight: 2 };
  const g = lossAndDeltas(m, sample), epsilon = 1e-6;
  for (const kind of ['user', 'item']) for (const field of ['w1', 'b1', 'w2', 'b2']) {
    const index = 1, old = m[kind][field][index];
    m[kind][field][index] = old + epsilon; const plus = lossAndDeltas(m, sample).loss;
    m[kind][field][index] = old - epsilon; const minus = lossAndDeltas(m, sample).loss; m[kind][field][index] = old;
    const v = g[kind];
    const expected = field === 'w1' ? v.first[Math.floor(index / m.input)] * v.state.input[index % m.input] : field === 'b1' ? v.first[index] : field === 'w2' ? v.second[Math.floor(index / m.hidden)] * v.state.h[index % m.hidden] : v.second[index];
    assert.ok(Math.abs((plus - minus) / (2 * epsilon) - expected) < 1e-5, kind + '.' + field);
  }
  assert.ok(Math.abs(Math.hypot(...forward(m, m.user, sample.user).vector) - 1) < 1e-12);
  assert.equal(validateTower(m), false);
});

test('bounded MLP learns separated interests without changing input and rejects malformed training', async () => {
  const a = normalize([1, .1]), b = normalize([.1, 1]);
  const rows = Array.from({ length: 80 }, (_, i) => ({ user: i % 2 ? a : b, item: i % 4 < 2 ? a : b, label: Number((i % 2 === 1) === (i % 4 < 2)), weight: 1 }));
  const before = structuredClone(rows), r = await trainMLP(rows, { hidden: 4, epochs: 12 });
  assert.ok(r.losses.at(-1) < r.losses[0]); assert.ok(mlpScore(r.model, a, a) > mlpScore(r.model, a, b));
  assert.ok(mlpScore(r.model, b, b) > mlpScore(r.model, b, a)); assert.deepEqual(rows, before);
  await assert.rejects(trainMLP(rows, { epochs: 99 })); await assert.rejects(trainMLP(rows.map(s => ({ ...s, label: 3 }))));
});
