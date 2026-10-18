import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { localDatabase } from './recommendation-local-db.mjs';
import { trainingSamples } from '../server/recommendation/training.mjs';
import { cosine } from '../server/recommendation/features.mjs';
import { experimentConfigs, trainExperiment, partitionSamples, evaluateExperiment, experimentScore, pairedInterval } from './lib/tower-experiment.mjs';

// Local, read-only data access. No production connection, model activation,
// generated interactions, or database artifact writes are performed here.
const db = await localDatabase(), started = performance.now();
const scope = process.argv.includes('--real') ? 'real' : 'synthetic';
const directory = new URL('../validation/tower-diagnosis/', import.meta.url);
try {
  const samples = await trainingSamples(db.query, scope);
  const report = { startedAt: new Date().toISOString(), scope, activation: false, source: 'existing mature exposures; labels unchanged', node: process.version,
    datasetDigest: createHash('sha256').update(JSON.stringify(samples)).digest('hex'), samples: samples.length };
  await mkdir(directory, { recursive: true });
  if (samples.length < 300) { report.status = 'insufficient_data'; await writeFile(new URL(scope + '-report.json', directory), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
  else {
    const split = partitionSamples(samples), baseline = s => cosine(s.user, s.item);
    report.partitions = Object.fromEntries(['train', 'validation', 'test'].map(k => [k, { samples: split[k].length, positive: split[k].filter(s => s.label).length, users: new Set(split[k].map(s => s.userId)).size }]));
    if (split.train.length < 150 || split.validation.length < 50 || split.test.length < 50) throw Error('Insufficient temporal coverage');
    report.baselineValidation = evaluateExperiment(split.validation, baseline);
    report.trials = []; let winner = null, best = -Infinity;
    for (const config of experimentConfigs) {
      const trialStarted = performance.now(), checkpoints = []; let checkpointBest = -Infinity, selected = null, selectedEpoch = null;
      const result = trainExperiment(split.train, config, { onCheckpoint(model, epoch) {
        const validation = evaluateExperiment(split.validation, s => experimentScore(model, s.user, s.item));
        checkpoints.push({ epoch, validation });
        if (validation.ndcgAtK > checkpointBest) { checkpointBest = validation.ndcgAtK; selected = structuredClone(model); selectedEpoch = epoch; }
      } });
      const trial = { ...config, parameters: result.parameters, lossStart: result.loss[0], lossEnd: result.loss.at(-1), pairedPositives: result.pairedPositives,
        selectedEpoch, validation: checkpoints.find(c => c.epoch === selectedEpoch).validation, checkpoints, trainingMs: Math.round(performance.now() - trialStarted) };
      report.trials.push(trial);
      if (trial.validation.ndcgAtK > best) { best = trial.validation.ndcgAtK; winner = { config, model: selected, epoch: selectedEpoch }; }
      console.log(JSON.stringify({ trial: config.name, parameters: trial.parameters, epoch: selectedEpoch, validationNdcg: trial.validation.ndcgAtK, ms: trial.trainingMs }));
      await writeFile(new URL(scope + '-report.json', directory), JSON.stringify({ ...report, status: 'running' }, null, 2));
    }
    // Freeze the choice using validation ONLY, then evaluate that one choice on
    // the historical test partition. It was evaluated in the previous release,
    // so this diagnostic must not be called new untouched real-user evidence.
    await writeFile(new URL(scope + '-selected.json', directory), JSON.stringify(winner));
    const predict = s => experimentScore(winner.model, s.user, s.item);
    report.selected = { name: winner.config.name, epoch: winner.epoch, validationNdcg: best, test: evaluateExperiment(split.test, predict), baselineTest: evaluateExperiment(split.test, baseline), interval: pairedInterval(split.test, predict, baseline) };
    report.evaluation = 'Chronological 60/20/20 with 7-day label embargo. Selection uses validation only. Historical holdout previously measured; synthetic results are not real-user quality evidence.';
    report.status = 'completed'; report.elapsedMs = Math.round(performance.now() - started);
    report.processPeakRssMiB = Math.round(process.resourceUsage().maxRSS / 1024); report.heapUsedMiB = Math.round(process.memoryUsage().heapUsed / 1048576);
    await writeFile(new URL(scope + '-report.json', directory), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, selected: report.selected, elapsedMs: report.elapsedMs, peakRssMiB: report.processPeakRssMiB }));
  }
} finally { await db.close(); }
