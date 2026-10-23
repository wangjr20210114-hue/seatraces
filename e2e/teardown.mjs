/* 关闭端到端测试服务并清理测试资源。 */

import { readFile, access } from "node:fs/promises";
export default async function teardown() {
  try {
    const s = JSON.parse(
      await readFile(
        new URL("../.runtime/ui-test/state.json", import.meta.url),
        "utf8",
      ),
    );
    await fetch("http://127.0.0.1:19888/__ui_test/stop", {
      method: "POST",
      headers: { "X-Test-Control": s.controlToken },
      signal: AbortSignal.timeout(3000),
    });
    for (let n = 0; n < 60; n++) {
      try {
        await access(
          new URL("../.runtime/ui-test/state.json", import.meta.url),
        );
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    console.warn(
      "Test cleanup timed out; inspect .runtime/ui-test before running again.",
    );
  } catch {
  }
}
