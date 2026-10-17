import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { coverage, browserIds } from "./coverage.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
export async function report(results = [], run = { status: "not-run" }) {
  const catalog = JSON.parse(
    await readFile(new URL("./catalog.json", import.meta.url), "utf8"),
  );
  const registered = new Set([...browserIds, ...Object.keys(coverage)]);
  let nativeRows=[];
  if(run.native?.startedAt){
    try {
      const source=JSON.parse(await readFile(path.join(root,'reports/ui/native-results.json'),'utf8'));
      if(source.startedAt===run.native.startedAt)nativeRows=source.rows;
    }catch{}
  }
  const rows = catalog.modules.flatMap((m) =>
    m.cases.map((c) => {
      const runs = results.filter((r) => r.id === c.id);
      const attempted = runs.filter((r) => r.status !== "skipped");
      const entry = coverage[c.id];
      const blocked = runs.some((r) => r.blocked);
      return {
        ...c,
        sheet: m.sheet,
        automation: browserIds.has(c.id)
          ? "浏览器操作"
          : entry?.kind === "native"
            ? "接口／算法检查"
            : "待外部条件／人工",
        evidence: entry?.evidence || [],
        evidenceDurationMs: entry?.evidence ? nativeRows.filter(r=>['test:pass','test:fail'].includes(r.type) && entry.evidence.some(e=>e.file===r.file&&r.name?.startsWith(e.prefix))).reduce((n,r)=>n+(r.durationMs||0),0) : null,
        scope: entry?.note || entry?.reason || "",
        result: blocked
          ? "阻塞"
          : attempted.length
            ? attempted.some((r) => !r.ok)
              ? "失败"
              : attempted.every((r) => r.status === "passed")
                ? attempted.every((r) => r.coverage === "full")
                  ? "通过"
                  : "部分通过"
                : "未完成"
            : "未执行",
        coverage: attempted.length
          ? attempted.every((r) => r.coverage === "full")
            ? "本用例已覆盖"
            : "部分覆盖"
          : blocked
            ? "尚未验证"
            : "待执行确认",
        runs,
      };
    }),
  );
  const out = path.join(root, "reports/ui");
  await mkdir(out, { recursive: true });
  const data = {
    generatedAt: new Date().toISOString(),
    catalogBaseline: catalog.commit,
    run,
    total: rows.length,
    registered: registered.size,
    executed: rows.filter((r) => r.runs.some((t) => t.status !== "skipped"))
      .length,
    passed: rows.filter((r) => r.result === "通过").length,
    partial: rows.filter((r) => r.result === "部分通过").length,
    blocked: rows.filter((r) => r.result === "阻塞").length,
    unexecuted: rows.filter((r) => r.result === "未执行").length,
    failed: rows.filter((r) => r.result === "失败").length,
    rows,
  };
  await writeFile(
    path.join(out, "case-results.json"),
    JSON.stringify(data, null, 2),
  );
  const csv = (v) =>
    '"' +
    String(v ?? "")
      .replace(/^[=+\-@]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  const table = [
    [
      "用例编号",
      "大模块",
      "子模块",
      "测试点",
      "优先级",
      "自动化",
      "结果",
      "覆盖范围",
      "步骤",
      "预期",
      "本编号检查耗时(ms)",
      "引用回归证据耗时(ms，共用证据不可跨行累加)",
      "说明",
    ],
    ...rows.map((c) => [
      c.id,
      c.module,
      c.sub,
      c.title,
      c.priority,
      c.automation,
      c.result,
      c.coverage,
      c.steps,
      c.expected,
      c.runs.reduce((a, r) => a + r.duration, 0),
      c.evidenceDurationMs,
      c.runs.map((r) => r.note).join("；") || c.scope,
    ]),
  ];
  await writeFile(
    path.join(out, "case-results.csv"),
    "\uFEFF" + table.map((row) => row.map(csv).join(",")).join("\r\n"),
  );
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const html = `<!doctype html><meta charset="utf-8"><title>SeaTraces UI 用例覆盖</title><style>
 body{font:15px system-ui;margin:24px;background:#f4f7fb;color:#22324b}h1{font-size:25px}header{position:sticky;top:0;background:#f4f7fb;padding:12px 0}input,select{padding:10px;border:1px solid #afbdce;border-radius:7px}table{width:100%;border-collapse:collapse;background:white}td,th{padding:12px;text-align:left;border-bottom:1px solid #dce4ec;vertical-align:top}th{background:#e6edf6}details{max-width:650px}pre{white-space:pre-wrap;font:inherit}small{color:#51647a}.失败{color:#b91c1c}.通过{color:#087b50}</style>
 <header><h1>SeaTraces 全量测试用例检查</h1><p>全部 ${data.total} 条 · 接入 ${data.registered} 条 · 本次执行 ${data.executed} 条 · 完整通过 ${data.passed} 条 · 部分通过 ${data.partial} 条 · 失败 ${data.failed} 条 · 阻塞 ${data.blocked} 条 · 未执行 ${data.unexecuted} 条</p>
 <p>同一次运行检查全部435条的可执行范围。接口/算法检查可被多条用例复用，不等于435条完整UI端到端验收。“部分通过”只代表展开后注明的范围；阻塞、未执行不计通过。真实地图、模型、邮件与真机需专项验收。</p>
 <p><a href="html/index.html">打开 Playwright 详细报告（截图／Trace）</a> · <a href="case-results.csv">Excel 可打开的结果 CSV</a> · <a href="case-results.json">JSON</a></p>
 <p><a href="native-events.ndjson">接口／数据库实际执行记录</a> · <a href="native-results.json">证据结果与耗时</a></p>
 <input id="q" placeholder="编号、模块、标题、操作步骤" size="40"><select id="s"><option value="">全部状态</option>${["通过", "部分通过", "失败", "阻塞", "未执行", "未完成"].map((s) => "<option>" + s + "</option>").join("")}</select>
 <small>生成于 ${esc(data.generatedAt)}；状态 ${esc(run.status)}；仅隔离测试库</small></header>
 <table><thead><tr><th>编号／模块</th><th>测试点及步骤</th><th>接入情况</th><th>本次结果</th></tr></thead><tbody>${rows.map((c) => `<tr data-state="${c.result}"><td>${esc(c.id)}<br>${esc(c.module)}<br><small>${esc(c.sub)}</small></td><td><details><summary>${esc(c.title)}</summary><p>前置：${esc(c.condition)}</p><pre>操作：\n${esc(c.steps)}\n\n预期：\n${esc(c.expected)}</pre><p>${esc(c.scope)}</p>${c.evidence.map((e) => `<p>执行证据：${esc(e.file)} → ${esc(e.prefix)}</p>`).join("")}${c.runs.map((r) => `<p>${esc(r.project)}：${esc(r.note)} · 汇总检查 ${r.duration} ms</p>`).join("")}</details></td><td>${c.automation}<br><small>${c.coverage}</small></td><td class="${c.result}">${c.result}</td></tr>`).join("")}</tbody></table>
 <script>const q=document.querySelector('#q'),s=document.querySelector('#s');function filter(){for(const r of document.querySelectorAll('tbody tr'))r.hidden=!!((s.value&&s.value!==r.dataset.state)||(q.value&&!r.textContent.toLowerCase().includes(q.value.toLowerCase())))}q.oninput=s.onchange=filter;</script>`;
  await writeFile(path.join(out, "case-index.html"), html);
  return data;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await report();
  console.log(
    `Catalog: ${r.total} cases, ${r.registered} registered. reports/ui/case-index.html`,
  );
}
