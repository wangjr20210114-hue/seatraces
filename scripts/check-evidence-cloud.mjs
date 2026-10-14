import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import dotenv from "dotenv";
import { fromOsm } from "../server/domain/place-candidate.mjs";
dotenv.config({ path: new URL("../.env", import.meta.url), quiet: true });
const { requestOsm } = await import("../server/integrations/osm.mjs");
const payload = JSON.parse(
  await readFile(
    new URL("../data/editorial/official-three-20261011.json", import.meta.url),
    "utf8",
  ),
);
const report = {
  at: new Date().toISOString(),
  places: [],
  totalFacts: 0,
  mode: "cloud_readback_via_existing_readonly_tunnel",
};
for (const id of new Set(payload.facts.map((f) => f.placeId))) {
  const start = performance.now();
  const result = await requestOsm("/place", { id });
  assert.equal(result.status, "live");
  assert.equal(result.item.id, id);
  const normalized = fromOsm(
    result.item,
    result,
    "scenic",
    new Date().toISOString(),
  );
  const expected = payload.facts.filter((f) => f.placeId === id);
  for (const row of expected) {
    const actual = result.item.facts[row.field],
      candidate = normalized.facts[row.field];
    assert.deepEqual(actual.value, row.value);
    assert.equal(actual.status, "evidence_reviewed");
    assert.equal(actual.evidence.sourceHash, row.evidence.sourceHash);
    assert.deepEqual(candidate.value, row.value);
    assert.equal(
      candidate.sourceUpdatedAt,
      new Date(row.sourceTimestamp).toISOString(),
    );
    assert.equal(
      candidate.retrievedAt,
      new Date(row.evidence.retrievedAt).toISOString(),
    );
    assert.ok(Date.parse(candidate.reviewAfter) > Date.now());
  }
  report.totalFacts += expected.length;
  report.places.push({
    id,
    name: result.item.name,
    status: result.status,
    factsVerified: expected.length,
    elapsedMs: Math.round(performance.now() - start),
    fields: expected.map((r) => r.field),
  });
  if (id === "osm:way/468359738")
    await writeFile(
      new URL(
        "../validation/enriched-place-example-20261011.json",
        import.meta.url,
      ),
      JSON.stringify(normalized, null, 2) + "\n",
    );
}
assert.equal(report.totalFacts, 10);
await writeFile(
  new URL(
    "../validation/evidence-cloud-readback-20261011.json",
    import.meta.url,
  ),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
