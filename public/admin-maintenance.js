import {mountDiagnostics} from './admin-diagnostics.js';
import {mountArchives} from './admin-archives.js';
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const time = (v) =>
  v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "—";
const states = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  cancelled: "已取消",
  open: "待处理",
  acknowledged: "已知悉",
  resolved: "已恢复",
};
const kinds = {
  log_export: "日志导出",
  place_refresh: "官方地点资料更新",
  health_check: "服务健康检查",
  event_archive: "事件归档",
  daily_rollup: "每日汇总",
  archive_restore: "恢复事件归档",
};
const steps = {
  exporting: "分批压缩日志",
  refreshing_official_sources: "核对官方资料",
  starting: "准备执行",
  checking_health: "检查服务指标",
  completed: "完成",
  archiving: "分批归档",
  restoring: "校验并恢复",
  summarizing: "生成每日汇总",
};
const errors = {
  WORKER_INTERRUPTED: "工作进程中断，请检查后重试",
  TASK_FAILED: "任务失败，请按任务编号排查",
  TASK_CANCELLED: "用户已取消",
  LEASE_LOST: "执行租约已失效",
  TASK_UNAVAILABLE: "当前版本未启用此任务",
  ARCHIVE_OVERSIZE: "单条事件超出归档预算",
  ARCHIVE_INVALID: "归档完整性校验未通过",
  ARCHIVE_CONFLICT: "存在内容不同的同编号记录，未覆盖",
  ARCHIVE_SOURCE_CHANGED: "预览中的源记录已变化，请重新预览",
};
const table = (heads, rows) =>
  `<div class="table-wrap"><table><thead><tr>${heads.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${heads.length}" class="empty">暂无记录</td></tr>`}</tbody></table></div>`;
export async function mountMaintenance({ content, status, api, isCurrent }) {
  let tab = "jobs",
    offset = 0,
    seq = 0,
    state = "all",
    poll;
  const current = (n) => isCurrent() && n === seq;
  async function detail(id) {
    clearTimeout(poll);
    const n = ++seq;
    status.textContent = "正在读取任务…";
    try {
      const r = await api("/api/admin/maintenance/tasks/" + id);
      if (!current(n)) return;
      const d = r.kind === "health_check" ? r.result?.data : null;
      content.innerHTML = `<button id="task-back">← 返回任务</button><article class="admin-card"><h3>${esc(kinds[r.kind] || r.kind)}</h3><p>${esc(states[r.state])} · ${time(r.created_at)}</p><p>任务编号 ${esc(r.id)}</p><p>开始 ${time(r.started_at)} · 结束 ${time(r.finished_at)}</p>${r.error_code ? `<p>${esc(errors[r.error_code] || "任务失败")}</p>` : ""}${r.cancel_requested && r.state === "running" ? "<p>已请求取消，将在当前安全步骤结束后停止。</p>" : ""}${r.progress?.step ? `<p>当前步骤：${esc(steps[r.progress.step] || r.progress.step)}</p>` : ""}${d ? `<p>堆内存 ${Math.round(d.heapUsedBytes / 1048576)} MB / ${Math.round(d.heapLimitBytes / 1048576)} MB · 待写日志 ${d.queued}</p><p>最近5分钟已记录请求 ${d.requests} 次 · 5xx ${d.errors} 次</p>` : ""}<details class="metric-definitions"><summary>技术摘要</summary><pre>${esc(JSON.stringify(r.result || r.progress, null, 2))}</pre></details>${(["queued", "running"].includes(r.state) || (r.kind!=="log_export" && ["failed", "interrupted", "cancelled"].includes(r.state))) ? `<form id="task-action" class="form-stack"><label class="confirm-inline"><input type="checkbox" required>确认${["queued", "running"].includes(r.state) ? "取消任务" : "创建重试任务"}</label><button class="primary">${["queued", "running"].includes(r.state) ? "取消任务" : "重试任务"}</button></form>` : ""}</article>`;
      content.querySelector("#task-back").onclick = () => void list();
      const form = content.querySelector("#task-action");
      if (form)
        form.onsubmit = async (e) => {
          e.preventDefault();
          const button = form.querySelector("button");
          button.disabled = true;
          const action = ["queued", "running"].includes(r.state)
            ? "cancel"
            : "retry";
          try {
            const v = await api(
              "/api/admin/maintenance/tasks/" + id + "/" + action,
              {
                version: r.version,
                confirmation: action + "-task",
                ...(action === "retry" ? { id: crypto.randomUUID() } : {}),
              },
            );
            if (current(n)) await detail(v.id);
          } catch (error) {
            if (current(n)) {
              status.textContent = error.message;
              button.disabled = false;
            }
          }
        };
      status.textContent = "";
      if (["queued", "running"].includes(r.state)) {
        const refresh = () => {
          if (!current(n) || document.hidden) return;
          if (content.querySelector("input[type=checkbox]:checked"))
            poll = setTimeout(refresh, 5000);
          else void detail(id);
        };
        poll = setTimeout(refresh, 5000);
      }
    } catch (error) {
      if (current(n)) status.textContent = error.message;
    }
  }
  async function list() {
    clearTimeout(poll);
    const n = ++seq;
    status.textContent = "正在读取维护状态…";
    try {
      const path =
        tab === "traces" ? "/api/admin/traces" : tab === "archives" ? '/api/admin/archives/policy' : tab === "jobs"
          ? "/api/admin/maintenance/tasks?" +
            new URLSearchParams({ state, offset })
          : tab === "health"
            ? "/api/admin/maintenance/health"
            : tab === "alerts"
              ? "/api/admin/maintenance/alerts?" +
                new URLSearchParams({ state, offset })
              : "/api/admin/tasks";
      const v = await api(path);
      if (!current(n)) return;
      content.innerHTML = `<div class="admin-tabs">${[
        ["jobs", "维护任务"],
        ["health", "服务监测"],
        ["traces", "请求链路与邮件"],
        ["alerts", "告警"],
        ["archives", "归档与汇总"],
        ["imports", "地点导入"],
      ]
        .map(
          ([k, name]) =>
            `<button data-maint-tab="${k}" aria-selected="${tab === k}">${name}</button>`,
        )
        .join("")}</div>`;
      if(tab==='traces'){await mountDiagnostics({content,status,api,isCurrent:()=>current(n),initial:v});}
      else if (tab === 'archives') {
        content.insertAdjacentHTML('beforeend','<section id="archive-panel"></section>');
        await mountArchives({content:content.querySelector('#archive-panel'),status,api,isCurrent:()=>current(n),policy:v,openTask:id=>void detail(id)});
      } else if (tab === "jobs") {
        content.insertAdjacentHTML(
          "beforeend",
          `<div class="actions"><button id="health-task" class="primary">运行健康检查</button><label>状态<select id="task-state">${["all", "queued", "running", "completed", "failed", "interrupted", "cancelled"].map((s) => `<option value="${s}">${states[s] || "全部"}</option>`).join("")}</select></label></div>` +
            table(
              ["任务", "状态", "申请人", "创建时间", "操作"],
              v.items.map(
                (r) =>
                  `<tr><td>${esc(kinds[r.kind] || r.kind)}</td><td>${esc(states[r.state])}${r.cancel_requested && r.state === "running" ? " · 正在取消" : ""}</td><td>${esc(r.requested_by || "系统")}</td><td>${time(r.created_at)}</td><td><button data-task="${r.id}">查看</button></td></tr>`,
              ),
            ),
        );
        const select = content.querySelector("#task-state");
        select.value = state;
        select.onchange = () => {
          state = select.value;
          offset = 0;
          void list();
        };
        content.querySelector("#health-task").onclick = async (e) => {
          e.target.disabled = true;
          try {
            const r = await api("/api/admin/maintenance/tasks", {
              id: crypto.randomUUID(),
              kind: "health_check",
              confirmation: "run-task",
            });
            if (current(n)) await detail(r.id);
          } catch (error) {
            if (current(n)) {
              status.textContent = error.message;
              e.target.disabled = false;
            }
          }
        };
        content
          .querySelectorAll("[data-task]")
          .forEach((b) => (b.onclick = () => void detail(b.dataset.task)));
        if (v.items.some((r) => ["queued", "running"].includes(r.state)))
          poll = setTimeout(() => {
            if (current(n) && !document.hidden) void list();
          }, 5000);
      } else if (tab === "health") {
        const sample = v.samples[0],
          d = sample?.data;
        content.insertAdjacentHTML(
          "beforeend",
          `<p class="coverage-note">${d ? "最近采样 " + time(sample.sampled_at) + (Date.now() - new Date(sample.sampled_at) > 120000 ? " · 采样已延迟" : "") : "尚无采样，可运行一次健康检查"} · 每60秒采样</p>${
            d
              ? `<div class="metrics">${[
                  ["堆内存使用", Math.round(d.heapUsedBytes / 1048576) + " MB"],
                  ["V8 堆上限", Math.round(d.heapLimitBytes / 1048576) + " MB"],
                  ["进程总内存", Math.round(d.rssBytes / 1048576) + " MB"],
                  ["日志队列", d.queued],
                ]
                  .map(
                    ([a, b]) =>
                      `<article class="metric"><span>${a}</span><strong>${b}</strong></article>`,
                  )
                  .join(
                    "",
                  )}</div><article class="admin-card"><h3>最近5分钟接口</h3><p>已记录 ${d.requests} 次 · 5xx ${d.errors} 次</p><p>${esc(v.requestCoverage)}</p></article>`
              : ""
          }<article class="admin-card"><h3>告警规则</h3>${Object.values(v.rules)
            .map((r) => `<p><b>${esc(r.name)}</b>：${esc(r.description)}</p>`)
            .join("")}</article>`,
        );
      } else if (tab === "alerts") {
        content.insertAdjacentHTML(
          "beforeend",
          `<div class="actions"><label>状态<select id="alert-state"><option value="active">未恢复</option><option value="resolved">已恢复</option><option value="all">全部</option></select></label></div>` +
            table(
              ["告警", "级别", "状态", "最近发生", "操作"],
              v.items.map(
                (r) =>
                  `<tr><td>${esc(v.rules[r.rule]?.name || r.rule)}<span class="table-secondary">${esc(JSON.stringify(r.observed))}</span></td><td>${r.level === "critical" ? "严重" : "警告"}</td><td>${esc(states[r.state])}</td><td>${time(r.last_seen_at)}</td><td>${r.state === "open" ? `<button data-ack="${r.id}">标记已知悉</button>` : "—"}</td></tr>`,
              ),
            ),
        );
        const select = content.querySelector("#alert-state");
        select.value = state;
        select.onchange = () => {
          state = select.value;
          offset = 0;
          void list();
        };
        content.querySelectorAll("[data-ack]").forEach(
          (b) =>
            (b.onclick = async () => {
              b.disabled = true;
              try {
                await api(
                  "/api/admin/maintenance/alerts/" +
                    b.dataset.ack +
                    "/acknowledge",
                  {
                    version: v.items.find((x) => x.id === b.dataset.ack)
                      .version,
                    confirmation: "acknowledge-alert",
                  },
                );
                if (current(n)) await list();
              } catch (error) {
                if (current(n)) {
                  status.textContent = error.message;
                  b.disabled = false;
                }
              }
            }),
        );
      } else
        content.insertAdjacentHTML(
          "beforeend",
          table(
            ["来源", "条数", "状态", "创建时间"],
            v.items.map(
              (r) =>
                `<tr><td>${esc(r.source)}</td><td>${r.rows_count}</td><td>${esc(r.status)}</td><td>${time(r.created_at)}</td></tr>`,
            ),
          ),
        );
      content.querySelectorAll("[data-maint-tab]").forEach(
        (b) =>
          (b.onclick = () => {
            tab = b.dataset.maintTab;
            state = tab === "alerts" ? "active" : "all";
            offset = 0;
            void list();
          }),
      );
      if (["jobs", "alerts"].includes(tab)) {
        content.insertAdjacentHTML(
          "beforeend",
          `<div class="pager"><button id="maint-prev" ${offset ? "" : "disabled"}>上一页</button><span>第 ${offset / 30 + 1} 页</span><button id="maint-next" ${v.hasMore ? "" : "disabled"}>下一页</button></div>`,
        );
        content.querySelector("#maint-prev").onclick = () => {
          offset -= 30;
          void list();
        };
        content.querySelector("#maint-next").onclick = () => {
          offset += 30;
          void list();
        };
      }
      status.textContent = "";
    } catch (error) {
      if (current(n)) status.textContent = error.message;
    }
  }
  await list();
}
