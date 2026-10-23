/* 实现离线推荐实验中的多层感知机训练与评分。 */

import { random, sigmoid } from '../../server/recommendation/model.mjs';

export const mlpAlgorithm = 'offline-semantic-mlp/1';
export function createMLP(input, hidden = 32, output = 32, seed = 7) {
  if (![2, 96, 608].includes(input) || ![4, 32, 64].includes(hidden) || ![2, 32].includes(output)) throw Error('Unsupported offline dimensions');
  const rng = random(seed);
  const matrix = (n, m) => Float64Array.from({ length: n * m }, () => (rng() * 2 - 1) * Math.sqrt(6 / (n + m)));
  const tower = () => ({ w1: matrix(hidden, input), b1: new Float64Array(hidden), w2: matrix(output, hidden), b2: new Float64Array(output) });
  return { algorithm: mlpAlgorithm, input, hidden, output, user: tower(), item: tower(), bias: 0, temperature: 4 };
}
export function forward(model, tower, input) {
  const h = new Float64Array(model.hidden), raw = new Float64Array(model.output);
  for (let i = 0; i < h.length; i++) {
    let sum = tower.b1[i]; for (let j = 0; j < model.input; j++) sum += tower.w1[i * model.input + j] * input[j];
    h[i] = Math.tanh(sum);
  }
  for (let i = 0; i < raw.length; i++) {
    let sum = tower.b2[i]; for (let j = 0; j < h.length; j++) sum += tower.w2[i * model.hidden + j] * h[j];
    raw[i] = Math.tanh(sum);
  }
  const norm = Math.max(1e-12, Math.hypot(...raw));
  return { input, h, raw, norm, vector: raw.map(x => x / norm) };
}
const dot = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[i]; return sum; };
export function mlpScore(model, user, item) {
  return sigmoid(model.temperature * dot(forward(model, model.user, user).vector, forward(model, model.item, item).vector) + model.bias);
}
function deltas(model, tower, state, vectorGradient) {
  const radial = dot(state.vector, vectorGradient), second = new Float64Array(model.output), first = new Float64Array(model.hidden);
  for (let i = 0; i < second.length; i++) second[i] = (vectorGradient[i] - state.vector[i] * radial) / state.norm * (1 - state.raw[i] ** 2);
  for (let j = 0; j < first.length; j++) {
    let sum = 0; for (let i = 0; i < second.length; i++) sum += tower.w2[i * model.hidden + j] * second[i];
    first[j] = sum * (1 - state.h[j] ** 2);
  }
  return { first, second };
}
export function lossAndDeltas(model, sample) {
  const u = forward(model, model.user, sample.user), p = forward(model, model.item, sample.item);
  const probability = sigmoid(model.temperature * dot(u.vector, p.vector) + model.bias), weight = Math.max(.1, Math.min(5, sample.weight ?? 1));
  const error = (probability - sample.label) * weight;
  return { loss: -weight * (sample.label * Math.log(probability + 1e-12) + (1 - sample.label) * Math.log(1 - probability + 1e-12)), error,
    user: { state: u, ...deltas(model, model.user, u, p.vector.map(x => model.temperature * error * x)) },
    item: { state: p, ...deltas(model, model.item, p, u.vector.map(x => model.temperature * error * x)) } };
}
function update(model, tower, gradients, rate) {
  const { first, second, state } = gradients;
  for (let i = 0; i < model.output; i++) {
    for (let j = 0; j < model.hidden; j++) { const k = i * model.hidden + j; tower.w2[k] -= rate * (second[i] * state.h[j] + .0001 * tower.w2[k]); }
    tower.b2[i] -= rate * second[i];
  }
  for (let i = 0; i < model.hidden; i++) {
    for (let j = 0; j < model.input; j++) { const k = i * model.input + j; tower.w1[k] -= rate * (first[i] * state.input[j] + .0001 * tower.w1[k]); }
    tower.b1[i] -= rate * first[i];
  }
}
export async function trainMLP(samples, { hidden = 32, epochs = 36, seed = 7, onCheckpoint, rate = .01 } = {}) {
  if (samples.length < 20 || samples.length > 20000 || !Number.isInteger(epochs) || epochs < 1 || epochs > 60) throw Error('Offline training bound exceeded');
  const input = samples[0].user.length;
  if (samples.some(s => ![0, 1].includes(s.label) || [s.user, s.item].some(v => v.length !== input || [...v].some(x => !Number.isFinite(x) || Math.abs(x) > 100)))) throw Error('Invalid offline sample');
  const model = createMLP(input, hidden, 32, seed), indices = samples.map((_, i) => i), rng = random(seed + 1), losses = [];
  for (let epoch = 1; epoch <= epochs; epoch++) {
    for (let i = indices.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [indices[i], indices[j]] = [indices[j], indices[i]]; }
    let loss = 0;
    for (const i of indices) {
      const gradients = lossAndDeltas(model, samples[i]); loss += gradients.loss;
      const learningRate = rate / (1 + (epoch - 1) * .04);
      update(model, model.user, gradients.user, learningRate); update(model, model.item, gradients.item, learningRate); model.bias -= learningRate * gradients.error;
    }
    if (!Number.isFinite(loss)) throw Error('Non-finite training loss');
    losses.push(loss / samples.length);
    if (epoch % 6 === 0 || epoch === epochs) await onCheckpoint?.(model, epoch, losses.at(-1));
  }
  return { model, losses, parameters: 2 * (input * hidden + hidden + hidden * 32 + 32) + 1 };
}
export function serializableMLP(model) {
  return { ...model, user: Object.fromEntries(Object.entries(model.user).map(([k, v]) => [k, Array.from(v)])), item: Object.fromEntries(Object.entries(model.item).map(([k, v]) => [k, Array.from(v)])) };
}
