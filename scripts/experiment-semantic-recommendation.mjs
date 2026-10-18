// Local, synthetic-only, read-only experiment. No server model activation.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { localDatabase } from './recommendation-local-db.mjs';
import { trainingSamples } from '../server/recommendation/training.mjs';
import { cosine } from '../server/recommendation/features.mjs';
import { partitionSamples, evaluateExperiment, pairedInterval } from './lib/tower-experiment.mjs';
import { cachedEmbedding, semanticSpec, digest, postText, profileText, temporalSemantics, combine, normalize } from './lib/offline-semantic.mjs';
import { trainMLP, mlpScore, serializableMLP } from './lib/offline-mlp.mjs';

if (process.argv.slice(2).some(arg => arg !== '--local')) throw Error('Only --local is accepted; this experiment does not support real or production data');
const directory = new URL('../validation/tower-semantic/', import.meta.url), cache = fileURLToPath(new URL('cache/', directory));
const configurations = [
  { name: 'structured-mlp32', semantic: false, history: false, hidden: 32, epochs: 36 },
  { name: 'semantic-static-mlp32', semantic: true, history: false, hidden: 32, epochs: 36 },
  { name: 'semantic-history-mlp32', semantic: true, history: true, hidden: 32, epochs: 36 },
  { name: 'semantic-history-mlp64', semantic: true, history: true, hidden: 64, epochs: 36 },
];
await mkdir(directory, { recursive: true });
const db = await localDatabase(), started = performance.now(); let encoder;
const report = { startedAt: new Date().toISOString(), status: 'preparing', scope: 'existing local synthetic data', activation: false, semanticSpec, configurations,
  evaluationLimit: 'Historical user-pooled test set was previously inspected; synthetic labels use cosine. Not fresh real-user quality evidence.',
  historyPolicy: 'Only positive feedback with a fully closed seven-day window, preceding the current exposure; last 30 days, at most 20 items; no current/future labels.',
  cache: { hits: 0, misses: 0 }, trials: [] };
const save = async () => writeFile(new URL('report.json', directory), JSON.stringify({ ...report, elapsedMs: Math.round(performance.now() - started), peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576) }, null, 2));
try {
  const samples = await trainingSamples(db.query, 'synthetic');
  if (samples.length > 5000) throw Error('This bounded offline semantic run supports at most 5000 samples; do not silently truncate a larger dataset');
  const split = partitionSamples(samples), ids = [...new Set(samples.map(s => s.postId))];
  if (ids.length > 1000) throw Error('Offline corpus limited to 1000 posts');
  report.datasetDigest = digest(samples); report.samples = samples.length;
  report.partitions = Object.fromEntries(['train', 'validation', 'test'].map(k => [k, split[k].length]));
  if (split.train.length < 150 || split.validation.length < 50 || split.test.length < 50) throw Error('Insufficient temporal coverage');
  const posts = (await db.query('SELECT id,title,body,tags,revision,created_at,updated_at FROM posts WHERE is_synthetic AND id=ANY($1::uuid[]) ORDER BY id', [ids])).rows;
  const byPost = new Map(posts.map(p => [p.id, p]));
  // No historical text revision store exists: refuse any text that may have
  // been edited after its exposure instead of leaking its latest contents.
  for (const row of samples) {
    const p = byPost.get(row.postId);
    if (!p || p.revision !== 1 || new Date(p.updated_at).getTime() > row.at || new Date(p.created_at).getTime() > row.at) throw Error('Historical text provenance unavailable; do not use current edited text');
  }
  report.corpusDigest = digest(posts.map(p => [p.id, p.revision, postText(p)]));
  report.posts = posts.length; report.originalBaselineValidation = evaluateExperiment(split.validation, s => cosine(s.user, s.item));
  // Save the fixed configurations and corpus identities before any training.
  await save();
  const encode = async text => {
    if (!encoder) {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowRemoteModels = false; env.localModelPath = fileURLToPath(new URL('../.runtime/models/', import.meta.url));
      encoder = await pipeline('feature-extraction', 'bge-small-zh-v1.5', { dtype: 'q8', device: 'cpu', local_files_only: true, session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } });
    }
    const r = await encoder([text], { pooling: 'cls', normalize: true, truncation: true, max_length: semanticSpec.maxTokens });
    return r.tolist()[0];
  };
  const cached = async text => { const r = await cachedEmbedding(cache, text, encode); report.cache[r.hit ? 'hits' : 'misses']++; return r.vector; };
  const items = new Map(), queries = new Map();
  report.status = 'encoding'; await save();
  for (const p of posts) {
    items.set(p.id, await cached(postText(p)));
    if (items.size % 50 === 0) { report.encodedPosts = items.size; await save(); console.log(JSON.stringify({ phase: 'encoding', posts: items.size, total: posts.length })); }
  }
  for (const row of samples) { const text = profileText(row.user); if (!queries.has(text)) queries.set(text, await cached(text)); }
  if (encoder) { await encoder.dispose(); encoder = null; }
  const semantic = temporalSemantics(samples, items, queries);
  report.uniqueSemanticPostVectors = new Set([...items.values()].map(v => digest(v))).size;
  report.semanticUsersWithHistory = new Set(samples.filter(s => semantic.get(s).historyCount).map(s => s.userId)).size;
  report.historyRows = samples.filter(s => semantic.get(s).historyCount).length;
  report.maxHistoryCount = Math.max(...[...semantic.values()].map(v => v.historyCount));
  if ([...semantic].some(([s, v]) => v.latestHistoryWindowEnd !== null && v.latestHistoryWindowEnd >= s.at)) throw Error('Temporal leakage detected');
  report.zeroShotValidation = Object.fromEntries(['static', 'history'].map(mode => [mode, evaluateExperiment(split.validation, s => cosine(mode === 'static' ? semantic.get(s).staticUser : semantic.get(s).user, semantic.get(s).item))]));
  report.status = 'training'; await save(); let selected = null;
  const inputs = (s, config) => config.semantic ? { user: combine(s.user, config.history ? semantic.get(s).user : semantic.get(s).staticUser), item: combine(s.item, semantic.get(s).item) } : { user: normalize(s.user), item: normalize(s.item) };
  for (const config of configurations) {
    const clock = performance.now(), prepared = new Map(samples.map(s => [s, { ...s, ...inputs(s, config) }]));
    const checkpoints = []; let best = null;
    const result = await trainMLP(split.train.map(s => prepared.get(s)), { ...config, onCheckpoint: async (model, epoch, loss) => {
      const validation = evaluateExperiment(split.validation, s => mlpScore(model, prepared.get(s).user, prepared.get(s).item));
      checkpoints.push({ epoch, loss, validation });
      if (!best || validation.ndcgAtK > best.validation.ndcgAtK) best = { model: structuredClone(model), epoch, validation };
      console.log(JSON.stringify({ phase: 'training', trial: config.name, epoch, loss, validationNdcg: validation.ndcgAtK }));
      report.current = { name: config.name, epoch, validation }; await save();
    } });
    report.trials.push({ ...config, parameters: result.parameters, selectedEpoch: best.epoch, validation: best.validation, checkpoints, trainingMs: Math.round(performance.now() - clock) });
    if (!selected || best.validation.ndcgAtK > selected.validation.ndcgAtK) selected = { ...best, config };
    await save();
  }
  // Freeze the model/epoch on validation before touching historical test metrics.
  await writeFile(new URL('selected.json', directory), JSON.stringify({ ...selected, model: serializableMLP(selected.model), activation: false }));
  const predict = s => { const p = inputs(s, selected.config); return mlpScore(selected.model, p.user, p.item); }, baseline = s => cosine(s.user, s.item);
  report.selected = { name: selected.config.name, epoch: selected.epoch, validation: selected.validation, test: evaluateExperiment(split.test, predict), baselineTest: evaluateExperiment(split.test, baseline), interval: pairedInterval(split.test, predict, baseline) };
  report.passesHistoricalThreshold = selected.validation.ndcgAtK > report.originalBaselineValidation.ndcgAtK + .005 && report.selected.test.ndcgAtK > report.selected.baselineTest.ndcgAtK + .005;
  report.status = 'completed'; delete report.current; await save(); console.log(JSON.stringify({ ...report.selected, passesHistoricalThreshold: report.passesHistoricalThreshold, activation: false }));
} catch (error) { report.status = 'failed'; report.error = error.message; await save(); throw error; }
finally { if (encoder) await encoder.dispose(); await db.close(); }
