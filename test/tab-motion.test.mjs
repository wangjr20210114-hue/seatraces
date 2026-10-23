/* 验证底部导航图标动画。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabMotion } from '../public/tab-motion.js';
test('tabs own distinct Lottie instances; same-tab selection never replays', () => {
  const calls = [], instances = [];
  const buttons = ['home','discover','profile'].map(page => ({ dataset: { page }, querySelector: () => ({ replaceChildren() {} }) }));
  let reduced = false;
  const motion = createTabMotion({ buttons, reducedMotion: () => reduced, lottie: { loadAnimation(options) {
    assert.equal(options.loop, false); assert.equal(options.autoplay, false);
    const instance = { goToAndStop: () => calls.push('stop:' + options.animationData.nm), goToAndPlay: () => calls.push('play:' + options.animationData.nm) };
    instances.push(instance); return instance;
  } } });
  assert.equal(new Set(instances).size, 3);
  assert.equal(motion.select('home'), false); assert.equal(calls.length, 0);
  assert.equal(motion.select('discover'), true);
  const count = calls.length;
  assert.equal(motion.select('discover'), false); assert.equal(calls.length, count);
  reduced = true; motion.select('profile');
  assert.equal(calls.filter(c => c.startsWith('play:')).length, 1);
});
