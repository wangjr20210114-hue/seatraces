import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "@playwright/test";
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const command = process.argv[2] || "run",
  extra = process.argv.slice(3);
const cli = path.join(root, "node_modules/@playwright/test/cli.js");
if (
  process.env.UI_BROWSER &&
  !["chrome", "msedge"].includes(process.env.UI_BROWSER)
)
  throw Error(
    "UI_BROWSER must be chrome or msedge, or unset for Playwright Chromium.",
  );
if (!process.env.UI_BROWSER && !existsSync(chromium.executablePath())) {
  const chrome =
    process.platform === "win32"
      ? [
          process.env.PROGRAMFILES +
            "\\Google\\Chrome\\Application\\chrome.exe",
          process.env.LOCALAPPDATA +
            "\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/usr/bin/google-chrome",
        ];
  const edge = [
    process.env["PROGRAMFILES(X86)"] +
      "\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  if (chrome.some(existsSync)) process.env.UI_BROWSER = "chrome";
  else if (edge.some(existsSync)) process.env.UI_BROWSER = "msedge";
  else if (!["report", "catalog"].includes(command)) {
    console.error(
      "Install a test browser first: npx playwright install chromium",
    );
    process.exit(1);
  }
}
const choices = {
  run: ["test"],
  open: ["test", "--ui"],
  headed: ["test", "--headed"],
  report: ["show-report", "reports/ui/html", "--host", "127.0.0.1"],
  repeat: ["test", "--grep", "E2E-018", "--repeat-each", "5"],
};
if (command === "catalog") {
  await (await import("../e2e/report.mjs")).report();
  console.log("reports/ui/case-index.html");
} else {
  let args = choices[command];
  if (!args) throw Error("Use run / open / headed / report / catalog / repeat");
  if (process.env.SEATRACES_UI_CASE) {
    const id = process.env.SEATRACES_UI_CASE.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]*(?:-\d{3})?$/.test(id))
      throw Error("Use a module such as AUTH or case such as AUTH-013");
    args = [...args, "--grep", id];
  }
  console.log(
    "SeaTraces UI: isolated app 19888, backend 19887, temporary PostgreSQL 55439.",
  );
  const result = spawnSync(process.execPath, [cli, ...args, ...extra], {
    stdio: "inherit",
    env: process.env,
    windowsHide: false,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
