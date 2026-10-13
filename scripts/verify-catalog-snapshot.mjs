import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

// Run only after a live catalog verification and intentional tunnel shutdown.
const base = process.env.TEST_URL || 'http://127.0.0.1:8787';
const report = { at: new Date().toISOString(), scope: 'Persisted OSM query cache after app restart with temporary tunnel closed', checks: [] };
async function check(name, path, verify) {
  try {
    const r = await fetch(base + '/api' + path);
    const data = await r.json();
    verify(r, data);
    report.checks.push({ name, passed: true, httpStatus: r.status, status: data.status || data.cacheStatus });
  } catch (e) { report.checks.push({ name, passed: false, error: e.message }); }
}
await check('coverage_is_historical', '/catalog/coverage', (r, d) => {
  assert.equal(r.status, 200); assert.equal(d.status, 'snapshot'); assert.equal(d.scope, 'cached_query_only'); assert.ok(d.cachedAt);
});
await check('known_query_returns_explicit_snapshot', '/catalog/search?q=' + encodeURIComponent('东京塔'), (r, d) => {
  assert.equal(r.status, 200); assert.equal(d.status, 'snapshot'); assert.equal(d.items[0].id, 'osm:relation/4247312');
});
await check('known_detail_retains_source_and_cache_time', '/catalog/place?id=' + encodeURIComponent('osm:relation/4247312'), (r, d) => {
  assert.equal(r.status, 200); assert.equal(d.cacheStatus, 'snapshot'); assert.ok(d.cachedAt);
  assert.equal(d.facts.lastEntry.sourceUrl, 'https://en.tokyotower.co.jp/');
});
await check('uncached_query_is_not_fabricated', '/catalog/search?q=uncached-' + Date.now(), (r, d) => {
  assert.equal(r.status, 503); assert.ok(d.error);
});
report.passed = report.checks.filter(c => c.passed).length;
report.failed = report.checks.length - report.passed;
await writeFile('validation/catalog-snapshot-20261011.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.failed ? 1 : 0;
