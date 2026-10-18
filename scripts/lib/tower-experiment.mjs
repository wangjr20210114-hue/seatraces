// Offline research only. These artifacts cannot be activated by the serving
// loader: wider embeddings require a separately reviewed model/schema release.
import { random, sigmoid, rankingMetrics } from '../../server/recommendation/model.mjs';
import { dot, validVector, clamp } from '../../server/recommendation/features.mjs';

export const experimentConfigs = Object.freeze([
  { name: 'current-32-18', width: 32, epochs: 18, objective: 'weighted-bce' },
  { name: 'longer-32-72', width: 32, epochs: 72, objective: 'weighted-bce' },
  { name: 'wider-64-72', width: 64, epochs: 72, objective: 'weighted-bce' },
  { name: 'wider-128-72', width: 128, epochs: 72, objective: 'weighted-bce' },
  { name: 'balanced-32-72', width: 32, epochs: 72, objective: 'balanced-bce' },
  { name: 'ranking-32-40', width: 32, epochs: 40, objective: 'pairwise' },
  { name: 'ranking-64-40', width: 64, epochs: 40, objective: 'pairwise' },
]);

export function partitionSamples(samples) {
  if (samples.length < 300) throw Error('At least 300 mature exposure pairs required');
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const a = sorted[Math.floor(sorted.length * .6)].at;
  const b = sorted[Math.floor(sorted.length * .8)].at;
  const week = 7 * 86400000;
  return {
    train: sorted.filter(s => s.at + week < a),
    validation: sorted.filter(s => s.at >= a && s.at + week < b),
    test: sorted.filter(s => s.at >= b),
    cutoff: a, testStarts: b,
  };
}
export const encodeExperiment = (model, kind, vector) => model[kind].map(row => Math.tanh(dot(row, vector)));
export const experimentScore = (model, user, item) => sigmoid(dot(encodeExperiment(model, 'user', user), encodeExperiment(model, 'item', item)) / Math.sqrt(model.width) + model.bias);
export const evaluateExperiment = (rows, score) => rankingMetrics(Object.values(Object.groupBy(rows, s => s.userId)), score);

export function trainExperiment(samples, config, { seed = 7, onCheckpoint } = {}) {
  const { width, epochs, objective } = config;
  if (![32, 64, 128].includes(width) || !Number.isInteger(epochs) || epochs < 1 || epochs > 100) throw Error('Invalid experiment capacity');
  if (!['weighted-bce', 'balanced-bce', 'pairwise'].includes(objective)) throw Error('Invalid objective');
  if (samples.length < 20 || samples.length > 20000 || samples.some(s => !validVector(s.user) || !validVector(s.item) || ![0, 1].includes(s.label))) throw Error('Invalid experiment samples');
  const init = random(seed), rng = random(seed + 1);
  const matrix = () => Array.from({ length: width }, () => Array.from({ length: 96 }, () => (init() - .5) * .35));
  const model = { algorithm: 'offline-tower-experiment/1', width, user: matrix(), item: matrix(), bias: 0 };
  const negatives = Object.groupBy(samples.filter(s => !s.label), s => s.userId);
  const rows = objective === 'pairwise' ? samples.filter(s => s.label && negatives[s.userId]?.length) : samples;
  if (!rows.length) throw Error('No within-user positive/negative pairs');
  const indices = rows.map((_, i) => i), loss = [], scale = Math.sqrt(width);
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = indices.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [indices[i], indices[j]] = [indices[j], indices[i]]; }
    const lr = .025 / (1 + epoch * .04); let total = 0;
    for (const i of indices) {
      const s = rows[i], u = encodeExperiment(model, 'user', s.user), p = encodeExperiment(model, 'item', s.item);
      if (objective === 'pairwise') {
        const pool = negatives[s.userId], negative = pool[Math.floor(rng() * pool.length)], n = encodeExperiment(model, 'item', negative.item);
        const prob = sigmoid((dot(u, p) - dot(u, n)) / scale), w = Math.sqrt(clamp(s.weight ?? 1, .1, 5)), err = (prob - 1) * w;
        total -= w * Math.log(prob + 1e-8);
        for (let h = 0; h < width; h++) {
          const du = err * (p[h] - n[h]) * (1 - u[h] ** 2) / scale;
          const dp = err * u[h] * (1 - p[h] ** 2) / scale, dn = -err * u[h] * (1 - n[h] ** 2) / scale;
          for (let k = 0; k < 96; k++) {
            model.user[h][k] -= lr * (du * s.user[k] + .0001 * model.user[h][k]);
            model.item[h][k] -= lr * (dp * s.item[k] + dn * negative.item[k] + .0001 * model.item[h][k]);
          }
        }
      } else {
        const prob = sigmoid(dot(u, p) / scale + model.bias);
        const w = objective === 'balanced-bce' ? 1 : clamp(s.weight ?? 1, .1, 5), err = (prob - s.label) * w;
        total -= w * (s.label * Math.log(prob + 1e-8) + (1 - s.label) * Math.log(1 - prob + 1e-8));
        for (let h = 0; h < width; h++) {
          const du = err * p[h] * (1 - u[h] ** 2) / scale, dp = err * u[h] * (1 - p[h] ** 2) / scale;
          for (let k = 0; k < 96; k++) {
            model.user[h][k] -= lr * (du * s.user[k] + .0001 * model.user[h][k]);
            model.item[h][k] -= lr * (dp * s.item[k] + .0001 * model.item[h][k]);
          }
        }
        model.bias -= lr * err;
      }
    }
    loss.push(total / rows.length);
    if ((epoch + 1) % 6 === 0 || epoch + 1 === epochs) onCheckpoint?.(model, epoch + 1);
  }
  return { model, loss, parameters: 2 * width * 96 + 1, pairedPositives: objective === 'pairwise' ? rows.length : null };
}

export function pairedInterval(rows, predict, baseline, { seed = 20261018, repeats = 2000 } = {}) {
  const differences = Object.values(Object.groupBy(rows, s => s.userId)).filter(g => g.some(s => s.label)).map(g => rankingMetrics([g], predict).ndcgAtK - rankingMetrics([g], baseline).ndcgAtK);
  if (differences.length < 5) return { users: differences.length, low: null, high: null };
  const rng = random(seed), means = [];
  for (let n = 0; n < repeats; n++) { let sum = 0; for (let j = 0; j < differences.length; j++) sum += differences[Math.floor(rng() * differences.length)]; means.push(sum / differences.length); }
  means.sort((a, b) => a - b);
  return { users: differences.length, mean: differences.reduce((a, b) => a + b, 0) / differences.length, low: means[Math.floor(repeats * .025)], high: means[Math.floor(repeats * .975)], method: 'paired user bootstrap, diagnostic 95% interval' };
}
