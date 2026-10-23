/* 验证地点目录检索与展示。 */

import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { allCases, coverage } from "../coverage.mjs";

let native;
for (const c of allCases) {
  const entry = coverage[c.id];
  if (!entry) continue;
  test(
    `${c.id} ${c.title} @${c.id.split("-")[0]}`,
    {
      annotation: [
        { type: "case", description: c.id },
        { type: "coverage", description: entry.coverage },
        { type: "method", description: entry.kind },
        { type: "scope", description: entry.note || entry.reason },
      ],
    },
    async ({}, info) => {
      if (entry.kind === "blocked") {
        info.annotations.push({ type: "blocked", description: entry.reason });
        test.skip(true, entry.reason);
      }
      native ||= JSON.parse(
        await readFile(
          new URL("../../reports/ui/native-results.json", import.meta.url),
          "utf8",
        ),
      );
      const evidence = [];
      for (const ref of entry.evidence) {
        const matches = native.rows.filter(
          (r) => r.file === ref.file && r.name?.startsWith(ref.prefix),
        );
        expect(
          matches.length,
          `No executed evidence: ${ref.file} :: ${ref.prefix}`,
        ).toBeGreaterThan(0);
        evidence.push(...matches);
      }
      await info.attach("actual-execution-evidence", {
        body: Buffer.from(
          JSON.stringify(
            { case: c.id, scope: entry.note, run: native.startedAt, evidence },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
      for (const result of evidence) {
        expect(
          result.skip || result.todo,
          `Required evidence skipped: ${result.name}`,
        ).toBeFalsy();
        expect(
          result.type,
          `${result.name}: ${JSON.stringify(result.error)}`,
        ).toBe("test:pass");
      }
    },
  );
}
