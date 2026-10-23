/* 提供界面测试命令菜单。 */

import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const runner = path.join(root, "scripts/ui-test.mjs");
const extra = process.argv.slice(2);
const run = (action, env = process.env) => {
  const child = spawnSync(process.execPath, [runner, action, ...extra], {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (child.error) throw child.error;
  return child.status ?? 1;
};

async function main() {
  if (!existsSync(path.join(root, "node_modules/@playwright/test/cli.js"))) {
    console.error("请先在项目目录运行 npm ci，然后重新打开本文件。");
    return 1;
  }
  console.log(`
SeaTraces 自动化 UI 测试
1. 全部 435 条检查（网页＋接口＋条件检查，默认无窗口）
2. 打开 Playwright 可视化测试面板
3. 按用例编号或模块运行
4. 打开上次详细测试报告
5. 打开全部 435 条用例目录
6. 快速切换页面重复回归（5 轮）
0. 退出`);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    process.stdout.write(prompt);
    const next = await lines.next();
    return next.done ? null : next.value.trim();
  };
  let choice, id;
  try {
    choice = await ask("选择 [0-6]：");
    if (choice === null || choice === "0") return 0;
    choice ||= "1";
    if (!/^[1-6]$/.test(choice)) {
      console.error("请输入 0 至 6。");
      return 1;
    }
    if (choice === "3") {
      id = (
        await ask("输入编号（如 AUTH-013）或模块（如 E2E）：")
      )?.toUpperCase();
      if (!id || !/^[A-Z][A-Z0-9]*(?:-\d{3})?$/.test(id)) {
        console.error("请输入正确的用例编号或模块，例如 AUTH-013、E2E。");
        return 1;
      }
    }
  } finally {
    input.close();
  }
  const env = { ...process.env };
  delete env.SEATRACES_UI_CASE;
  if (id) env.SEATRACES_UI_CASE = id;
  let code = 0;
  if (choice === "5") {
    const file = path.join(root, "reports/ui/case-index.html");
    if (!existsSync(file)) code = run("catalog", env);
    if (code === 0) {
      const child = spawn("explorer.exe", [file], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    }
  } else {
    const action = { 1: "run", 2: "open", 3: "run", 4: "report", 6: "repeat" }[
      choice
    ];
    code = run(action, env);
  }
  console.log(`\n结果目录：${path.join(root, "reports/ui")}\n退出码：${code}`);
  return code;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
