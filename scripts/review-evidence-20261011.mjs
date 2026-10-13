// One reviewed batch, not a general automatic approval workflow.
// Run only after comparing the 10 values with the saved official excerpts.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { validateExtractedFacts } from "../server/services/evidence-extraction.mjs";
const dir = new URL("../.runtime/evidence-20261011/", import.meta.url);
const bundle = JSON.parse(await readFile(new URL("bundle.json", dir), "utf8"));
const now = new Date().toISOString(),
  result = { aliases: [], facts: [] };
const reviewChanges = [];
for (const place of bundle.places) {
  const response = JSON.parse(
    await readFile(
      new URL(
        "extracted-" + place.placeId.replaceAll(/[^a-z0-9]/g, "_") + ".json",
        dir,
      ),
      "utf8",
    ),
  );
  if (place.placeId === "osm:way/542534202") {
    const row = response.facts.find((f) => f.field === "reservation");
    const original = JSON.parse(JSON.stringify(row));
    const source = place.evidence.find(
      (e) => e.id === "museum-reservation",
    ).text;
    row.quote = source
      .slice(source.indexOf("本馆实行"), source.indexOf("每张有效身份证件"))
      .trim();
    row.value =
      "普通个人观众实行实名制分时段预约，可提前七天（包含预约当天）预约；有余票可当日预约。常规16:00停止入馆时，15:40停止当日预约。优待人群按官网细则办理。";
    reviewChanges.push({
      placeId: place.placeId,
      field: row.field,
      reason:
        "模型拼接了不连续的引文，自动校验拒绝；经原文复核后缩小摘要范围并恢复连续引文",
      original,
      corrected: row,
    });
  }
  const facts = validateExtractedFacts(response, place, now);
  if (facts.length !== place.expectedFacts)
    throw Error("Incomplete reviewed batch");
  for (const fact of facts) {
    fact.verifiedAt = now;
    Object.assign(fact.evidence, {
      reviewStatus: "accepted",
      reviewMethod: "source_excerpt_review",
      reviewedBy: "Codex assisted editorial review",
      extractionModel: "deepseek-flash",
      batchId: "official-three-20261011",
      uncertainty:
        "按本次取得的官方常规规则整理；原页发布日保留，采集日不代表规则更新日。临时公告、余票和实际成交价未实时保证。",
    });
  }
  result.facts.push(...facts);
}
await mkdir(new URL("../data/editorial/", import.meta.url), {
  recursive: true,
});
await writeFile(
  new URL("../data/editorial/official-three-20261011.json", import.meta.url),
  JSON.stringify(result, null, 2) + "\n",
);
await writeFile(
  new URL("../validation/evidence-review-20261011.json", import.meta.url),
  JSON.stringify(
    { at: now, places: 3, facts: result.facts.length, reviewChanges },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    places: 3,
    facts: result.facts.length,
    correctedQuotes: reviewChanges.length,
    cloudWritten: false,
  }),
);
