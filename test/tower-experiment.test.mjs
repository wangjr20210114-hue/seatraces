/* 验证双塔模型离线实验。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { trainTower, towerScore, validateTower } from '../server/recommendation/model.mjs';
import { profileVector } from '../server/recommendation/features.mjs';
import { trainExperiment, experimentScore, partitionSamples, pairedInterval } from '../scripts/lib/tower-experiment.mjs';
const a = profileVector({}, { interests: ['人文'] }), b = profileVector({}, { interests: ['自然'] });
const rows = Array.from({ length: 100 }, (_, i) => ({ userId: String(i % 2), user: i % 2 ? a : b, item: i % 4 < 2 ? a : b, label: Number((i % 2 === 1) === (i % 4 < 2)), weight: 1 }));

test('offline default reproduces production SGD exactly and cannot pass serving validation', () => {
  const reference = trainTower(rows, { epochs: 18 });
  const result = trainExperiment(rows, { width: 32, epochs: 18, objective: 'weighted-bce' });
  assert.deepEqual(result.model.user, reference.model.user); assert.deepEqual(result.model.item, reference.model.item);
  assert.deepEqual(result.loss, reference.loss); assert.equal(result.model.bias, reference.model.bias);
  assert.equal(experimentScore(result.model, a, b), towerScore(reference.model, a, b));
  assert.equal(validateTower(result.model), false); assert.equal(result.parameters, 6145);
});
test('larger and ranking objectives learn held-out feature combinations without mutating samples', () => {
  const copy = structuredClone(rows);
  for (const objective of ['weighted-bce', 'balanced-bce', 'pairwise']) {
    const result = trainExperiment(rows, { width: 64, epochs: 30, objective });
    assert.ok(result.loss.at(-1) < result.loss[0]); assert.ok(experimentScore(result.model, a, a) > experimentScore(result.model, a, b));
    assert.ok(experimentScore(result.model, b, b) > experimentScore(result.model, b, a)); assert.equal(result.parameters, 12289);
  }
  assert.deepEqual(rows, copy);
});
test('time partitions embargo the full label window and reject small/invalid training inputs', () => {
  const data = Array.from({ length: 400 }, (_, i) => ({ ...rows[i % rows.length], at: i * 86400000 }));
  const split = partitionSamples(data);
  assert.ok(split.train.at(-1).at + 7 * 86400000 < split.validation[0].at);
  assert.ok(split.validation.at(-1).at + 7 * 86400000 < split.test[0].at);
  assert.throws(() => partitionSamples(data.slice(0, 20)));
  assert.throws(() => trainExperiment(rows, { width: 4096, epochs: 1, objective: 'weighted-bce' }));
  assert.throws(() => trainExperiment(rows.map(r => ({ ...r, label: 8 })), { width: 32, epochs: 18, objective: 'weighted-bce' }));
});
test('paired uncertainty is user-based and does not claim an improvement for identical scores', () => {
  const data = Array.from({ length: 10 }, (_, n) => rows.map(r => ({ ...r, userId: n + ':' + r.userId }))).flat();
  const result = pairedInterval(data, s => s.label, s => s.label);
  assert.equal(result.low, 0); assert.equal(result.high, 0); assert.equal(result.users, 20);
});
