/* 收集 Playwright 用例结果和覆盖信息。 */

import { report } from "./report.mjs";
import { readFile } from "node:fs/promises";
export default class CatalogReporter {
  results = [];
  onTestEnd(test, result) {
    const a = (type) =>
      test.annotations.find((a) => a.type === type)?.description;
    if (!a("case")) return;
    this.results.push({
      id: a("case"),
      project: test.parent.project()?.name || "desktop",
      status: result.status,
      ok: result.status === test.expectedStatus,
      coverage: a("coverage"),
      note: a("scope"),
      method: a("method") || "browser",
      blocked: a("blocked"),
      duration: result.duration,
    });
  }
  async onEnd(result) {
    let native;
    try {
      const n = JSON.parse(
        await readFile(
          new URL("../reports/ui/native-results.json", import.meta.url),
          "utf8",
        ),
      );
      native = {
        exitCode: n.exitCode,
        startedAt: n.startedAt,
        finishedAt: n.finishedAt,
        files: n.files.length,
        passed: n.rows.filter(
          (r) => r.type === "test:pass" && !r.skip && !r.todo,
        ).length,
        skipped: n.rows.filter((r) => r.skip || r.todo).length,
        failures: n.rows
          .filter((r) => r.type === "test:fail")
          .map((r) => ({ file: r.file, name: r.name, error: r.error })),
      };
    } catch {}
    const status =
      result.status === "passed" && native?.exitCode !== 0
        ? "failed"
        : result.status;
    await report(this.results, {
      status,
      native,
      durationMs: result.duration,
      startedAt: result.startTime,
    });
    if (status !== result.status) return { status };
  }
}
