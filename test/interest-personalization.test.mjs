import test from 'node:test';
import assert from 'node:assert/strict';
import { personalizedQuestions, orderedInterestOptions } from '../server/services/questions.mjs';
import { clusterScenicPlaces, scorePlace } from '../server/domain/scenic-clusters.mjs';
import { byScore } from '../public/scenic-view.js';

test('question options follow signal strength, retain all choices, and prioritize explicit preferences', async () => {
  const options = ['人文', '自然', '园林', '艺术'];
  assert.deepEqual(orderedInterestOptions(options, { tagWeights: { 人文: 0, 自然: -.8, 艺术: .3, 园林: .8 } }), ['园林', '艺术', '人文', '自然']);
  assert.deepEqual(orderedInterestOptions(options, { interests: ['自然'], tagWeights: { 园林: .8 } }), ['自然', '园林', '人文', '艺术']);
  assert.deepEqual(orderedInterestOptions(options, { tagWeights: { 人文: NaN, 自然: Infinity, 园林: -1 } }), options);
  const result = await personalizedQuestions({ styleWeights: { 园林: .8 } }, { enabled: false });
  assert.equal(result.questions[0].options[0], '园林'); assert.match(result.questions[0].title, /园林/);
  const changed = await personalizedQuestions({ styleWeights: { 艺术: .9, 园林: 0 } }, { enabled: false });
  assert.equal(changed.questions[0].options[0], '艺术'); assert.ok(!changed.questions[0].title.includes('园林'));
});
test('model can reorder approved questions only, never inject options or remove questions', async () => {
  const result = await personalizedQuestions({ tagWeights: { 园林: .8 } }, { enabled: true, model: async () => ({ ids: ['transport'] }) });
  assert.deepEqual(result.questions.map(q => q.id), ['transport', 'interests', 'pace']);
  assert.equal(result.questions.find(q => q.id === 'interests').options[0], '园林');
  const fallback = await personalizedQuestions({}, { enabled: true, model: async () => ({ ids: ['delete_everything'] }) });
  assert.equal(fallback.questions.length, 3); assert.match(fallback.source, /暂不可用/);
});
test('personal place order is distinct from summed popularity and preserves the entire cluster', () => {
  const garden = { id: 'garden', name: '园林', category: 'leisure', lat: 31, lng: 121, traits: { leisure: 'garden' } };
  const museum = { id: 'museum', name: '博物馆', category: 'attraction', lat: 31.001, lng: 121.001, traits: { tourism: 'museum', wikipedia: 'museum', wikidata: 'Q1' } };
  const preferences = { styleWeights: { 园林: .8 } };
  const roots = clusterScenicPlaces([museum, garden], preferences).flatMap(c => c.members);
  assert.equal(roots.length, 2); assert.equal(roots[0].id, garden.id); assert.deepEqual(byScore(roots).map(p => p.id), roots.map(p => p.id));
  assert.ok(scorePlace(museum, preferences).total > scorePlace(garden, preferences).total);
  const noPreference = clusterScenicPlaces([museum, garden]).flatMap(c => c.members);
  assert.equal(noPreference[0].id, museum.id);
  assert.equal(byScore([{ ...museum, score: { total: 9999, personalInterest: 0 } }, { ...garden, score: { total: 20, personalInterest: 3 } }])[0].id, garden.id);
});
