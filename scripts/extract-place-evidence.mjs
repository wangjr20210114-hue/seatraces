// Exactly 3 calls, all metered; extraction only. Import requires separate evidence review.
import { readFile, writeFile } from "node:fs/promises";
import dotenv from "dotenv";
import {
  validateExtractedFacts,
  extractionInstruction,
} from "../server/services/evidence-extraction.mjs";
dotenv.config({ path: new URL("../.env", import.meta.url), quiet: true });
if (process.argv.slice(2).join(" ") !== "--live")
  throw Error("Use --live for the bounded three-place extraction");
const local = JSON.parse(
  await readFile(new URL("../.runtime/local.json", import.meta.url), "utf8"),
);
process.env.DATABASE_URL = `postgresql://seatraces:${encodeURIComponent(local.password)}@127.0.0.1:${local.port}/seatraces`;
const { pool } = await import("../server/db.mjs");
const { llmJSON } = await import("../server/integrations/deepseek.mjs");
const bundle = JSON.parse(
  await readFile(
    new URL("../.runtime/evidence-20261011/bundle.json", import.meta.url),
    "utf8",
  ),
);
if (bundle.places.length !== 3) throw Error("Expected exactly 3 places");
const output = { aliases: [], facts: [] },
  report = {
    at: new Date().toISOString(),
    model: process.env.DEEPSEEK_MODEL || "deepseek-flash",
    places: [],
  };
let phase = "request";
try {
  for (const place of bundle.places) {
    const start = performance.now();
    const checkpoint = new URL(
      "../.runtime/evidence-20261011/extracted-" +
        place.placeId.replaceAll(/[^a-z0-9]/g, "_") +
        ".json",
      import.meta.url,
    );
    phase = "request";
    let response;
    try {
      response = JSON.parse(await readFile(checkpoint, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (!response) {
      response = await llmJSON(
        extractionInstruction,
        {
          name: place.name,
          placeId: place.placeId,
          evidence: place.evidence.map(({ id, fields, text }) => ({
            id,
            fields,
            text,
          })),
        },
        { maxTokens: 1800 },
      );
      await writeFile(checkpoint, JSON.stringify(response, null, 2) + "\n");
    }
    phase = "validate";
    const facts = validateExtractedFacts(response, place);
    if (facts.length !== place.expectedFacts)
      throw Error("Incomplete extraction: " + place.name);
    for (const f of facts) f.evidence.extractionModel = report.model;
    output.facts.push(...facts);
    report.places.push({
      name: place.name,
      placeId: place.placeId,
      facts: facts.length,
      elapsedMs: Math.round(performance.now() - start),
    });
    console.log(JSON.stringify(report.places.at(-1)));
  }
  await writeFile(
    new URL("../.runtime/evidence-20261011/draft.json", import.meta.url),
    JSON.stringify(output, null, 2) + "\n",
  );
  await writeFile(
    new URL("../validation/evidence-extraction-20261011.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
  );
} catch (e) {
  console.error(
    e.status
      ? `Extraction refused or unavailable (${e.status}); no import performed.`
      : JSON.stringify({
          error: "Extraction failed; no import performed.",
          phase,
          reason: phase === "validate" ? e.message : undefined,
          name: e.name,
          code: typeof e.code === "string" ? e.code : undefined,
          issues: e.issues?.map((i) => ({ path: i.path, code: i.code })),
        }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
