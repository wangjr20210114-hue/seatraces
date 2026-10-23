/* 构建语义特征缓存，按时间组织推荐实验输入。 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { styleDimensions } from '../../server/social/features.mjs';

export const semanticSpec = Object.freeze({ model: 'Xenova/bge-small-zh-v1.5', revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781', dtype: 'q8', pooling: 'cls', normalize: true, maxTokens: 256, dimensions: 512, version: 'offline-semantic/1' });
export const week = 7 * 86400000;
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function normalize(vector) {
  const norm = Math.hypot(...vector);
  return Array.from(vector, x => norm > 1e-12 ? x / norm : 0);
}
export function profileText(vector) {
  const liked = styleDimensions.filter((_, i) => vector[i] > .05).map(d => d.label);
  const avoided = styleDimensions.filter((_, i) => vector[i] < -.05).map(d => d.label);
  return '为这个句子生成表示以用于检索相关文章：旅行内容偏好：' + (liked.join('、') || '尚不明确') + (avoided.length ? '。不喜欢：' + avoided.join('、') : '');
}
export function postText(post) {
  return [String(post.title).slice(0, 100), (post.tags || []).join('、'), String(post.body).slice(0, 4000)].join('\n');
}
export function validEmbedding(v) {
  return Array.isArray(v) && v.length === semanticSpec.dimensions && v.every(Number.isFinite) && Math.abs(Math.hypot(...v) - 1) < .002;
}
export async function cachedEmbedding(directory, text, encode) {
  const key = digest({ semanticSpec, text }), path = join(directory, key + '.json');
  try {
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (record.key === key && validEmbedding(record.vector)) return { vector: record.vector, hit: true };
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const vector = await encode(text);
  if (!validEmbedding(vector)) throw Error('Invalid offline semantic embedding');
  await mkdir(directory, { recursive: true });
  const temp = path + '.tmp-' + process.pid;
  await writeFile(temp, JSON.stringify({ key, vector }));
  await rename(temp, path);
  return { vector, hit: false };
}
export function temporalSemantics(samples, itemVectors, queryVectors, { historyDays = 30, maxHistory = 20 } = {}) {
  const byUser = new Map(), output = new Map();
  for (const row of [...samples].sort((a, b) => a.at - b.at)) {
    const past = byUser.get(row.userId) || [];
    const eligible = past.filter(p => p.label === 1 && p.at + week < row.at && row.at - p.at <= historyDays * 86400000).slice(-maxHistory);
    const initial = queryVectors.get(profileText(row.user));
    if (!initial || !itemVectors.get(row.postId)) throw Error('Missing semantic input');
    let user = initial;
    if (eligible.length) {
      const sum = Array(semanticSpec.dimensions).fill(0);
      for (const p of eligible) {
        const vector = itemVectors.get(p.postId), weight = Math.min(5, p.weight) * 2 ** (-(row.at - p.at) / week);
        for (let i = 0; i < sum.length; i++) sum[i] += vector[i] * weight;
      }
      const history = normalize(sum);
      user = normalize(initial.map((x, i) => .6 * x + .4 * history[i]));
    }
    output.set(row, { staticUser: initial, user, item: itemVectors.get(row.postId), historyCount: eligible.length, latestHistoryWindowEnd: eligible.length ? Math.max(...eligible.map(p => p.at + week)) : null });
    past.push(row); byUser.set(row.userId, past);
  }
  return output;
}
export function combine(structured, semantic) {
  return [...normalize(structured).map(x => x * Math.SQRT1_2), ...semantic.map(x => x * Math.SQRT1_2)];
}
