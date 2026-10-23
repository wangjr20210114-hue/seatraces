/* 验证地点事实提取。 */

import test from "node:test";
import assert from "node:assert/strict";
import { validateExtractedFacts } from "../server/services/evidence-extraction.mjs";
import { fromOsm } from "../server/domain/place-candidate.mjs";
const now = "2026-10-11T09:00:00Z";
const evidence = {
  id: "a",
  fields: ["openingHours"],
  text: "开放时间为上午九时至下午五时。周一闭馆。",
  retrievedAt: now,
  publishedAt: "2025-01-01T00:00:00Z",
};
const place = { placeId: "osm:way/1", evidence: [evidence] };
test("reject fabricated/spliced evidence and expired announcements before import", () => {
  const row = {
    field: "openingHours",
    value: "9-17",
    evidenceId: "a",
    quote: "开放时间为上午九时至下午五时。",
  };
  assert.equal(validateExtractedFacts({ facts: [row] }, place, now).length, 1);
  assert.throws(() =>
    validateExtractedFacts(
      { facts: [{ ...row, quote: "上午九时。周一闭馆。" }] },
      place,
      now,
    ),
  );
  assert.throws(() =>
    validateExtractedFacts(
      { facts: [row] },
      {
        ...place,
        evidence: [{ ...evidence, validThrough: "2026-10-07T16:00:00Z" }],
      },
      now,
    ),
  );
});
test("expired editorial evidence in a cached response is not treated as current data", () => {
  const p = fromOsm(
    {
      id: "osm:way/1",
      name: "示例",
      lat: 31,
      lng: 120,
      category: "attraction",
      facts: {
        openingHours: {
          value: "9-17",
          source: "官网",
          sourceUrl: "https://example.org",
          status: "evidence_reviewed",
          evidence: { version: 1, reviewAfter: "2026-10-10T00:00:00Z" },
        },
      },
    },
    { status: "snapshot", cachedAt: "2026-10-09T00:00:00Z" },
    "scenic",
    now,
  );
  assert.equal(p.facts.openingHours.value, null);
  assert.equal(p.facts.openingHours.status, "needs_review");
});
