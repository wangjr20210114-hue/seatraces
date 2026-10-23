/* 在模拟器中执行端到端测试。 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import path from "node:path";
import { coverage } from "./coverage.mjs";

export async function runNative({ appRoot, root, password,dbPort=55439 }) {
  await cp(path.join(root, "test"), path.join(appRoot, "test"), {
    recursive: true,
  });
  await cp(path.join(root, "scripts"), path.join(appRoot, "scripts"), {
    recursive: true,
  });
  await mkdir(path.join(appRoot, ".runtime"), { recursive: true });
  const config = path.join(appRoot, ".runtime/local.json");
  await writeFile(config, JSON.stringify({ port: dbPort, password }), {
    mode: 0o600,
  });
  const files = [
    ...new Set(
      [...Object.values(coverage).flatMap((c) =>
        (c.evidence || []).map((e) => e.file),
      ), 'journey-recovery.test.mjs', 'journey-api.test.mjs'],
    ),
  ].sort();
  const out = path.join(root, "reports/ui");
  const events = path.join(out, "native-events.ndjson");
  const log = createWriteStream(events, { flags: "w" });
  const err = createWriteStream(path.join(out, "native-stderr.log"), {
    flags: "w",
  });
  const env = {
    ...process.env,
    ITERATION_DB_CONFIG: config,
    NODE_OPTIONS: "",
    TEST_ACCOUNTS: "1",
    TEST_OPERATIONS: "1",
    TEST_CITYWALK: "1",
    TEST_INBOX: "1",
    TEST_ITERATION: "1",
    TEST_GUEST: "1",
    TEST_PERSONAL: "1",
    TEST_SOCIAL: "1",
    TEST_AGENT: "1",
    TEST_TRIP_SERVICES: "1",
    TEST_DISCOVERY: "0",
    CATALOG_OUTPUT_PATH: out,
    TEST_CATALOG: "1",
    TEST_URL: "http://127.0.0.1:19887",
  };
  const reporter = new URL("./native-reporter.mjs", import.meta.url).href;
  const guard = new URL("./native-network.mjs", import.meta.url).href;
  console.log(
    `Catalog native regression: ${files.length} files, isolated PostgreSQL schemas.`,
  );
  const startedAt = new Date().toISOString();
  const child = spawn(
    process.execPath,
    [
      "--import",
      guard,
      "--test",
      "--test-concurrency=1",
      "--test-timeout=180000",
      "--test-reporter",
      reporter,
      ...files.map((f) => path.join(appRoot, "test", f)),
    ],
    { cwd: appRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let buffer = "";
  child.stdout.on("data", (bytes) => {
    log.write(bytes);
    buffer += bytes.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.nesting === 0 && e.name)
          console.log(
            `Native ${e.type === "test:fail" ? "FAIL" : e.skip ? "SKIP" : "OK"}: ${e.file} · ${e.name}`,
          );
      } catch {}
    }
  });
  child.stderr.pipe(err);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await new Promise((r) => log.end(r));
  await new Promise((r) => err.end(r));
  const rows = (await readFile(events, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  const result = {
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    files,
    rows,
  };
  await writeFile(
    path.join(out, "native-results.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(
    `Native regression finished, exit ${exitCode}; individual results retained.`,
  );
  return result;
}
