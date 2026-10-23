/* 展示 AI 对话、处理进度、操作预览和确认结果。 */

import { setIconLabel } from './ui-icons.js';
const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
const paths =
  /^\/(?:home|discover|profile|account|history(?:\/[a-f0-9-]{36})?|favorites|browsing|report|citywalk(?:\/(?:new|[a-f0-9-]{36}))?|agent|services\/[a-f0-9-]{36}(?:\?day=\d{1,2})?)$/;
export function mountAgent({
  content,
  setTitle,
  api,
  navigate,
  userId,
  context,
  isCurrent,
}) {
  setTitle("问 AI");
  content.classList.add("agent-page");
  const key = "seatraces-agent:" + userId;
  let conversationId = sessionStorage.getItem(key),
    revision = 0,
    busy = false,
    question,
    disposed = false,
    progressTimer,
    progressRequest,
    continueTimer,
    continueStarted = 0;
  const top = node("div", "agent-toolbar"),
    fresh = node("button", "agent-chip", "新对话"),
    memory = node("button", "agent-chip", "我的旅行风格");
  setIconLabel(fresh, '新对话', 'plus', true);
  setIconLabel(memory, '我的旅行风格', 'spark', true);
  top.append(fresh, memory);
  const log = node("div", "agent-log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-label", "问 AI 对话");
  const choices = node("div", "agent-choices");
  const status = node("p", "agent-status");
  status.setAttribute("role", "status");
  const form = node("form", "agent-composer"),
    input = node("textarea");
  input.rows = 2;
  input.maxLength = 1500;
  input.placeholder = "例如：明早去上海，玩两天，少走路";
  input.setAttribute("aria-label", "发给问 AI 的消息");
  const send = node("button", "primary", "发送");
  setIconLabel(send, '发送', 'up');
  send.type = "submit";
  form.append(input, send);
  content.replaceChildren(top, log, choices, status, form);
  const active = () => !disposed && isCurrent();
  function waiting(on) {
    busy = on;
    send.disabled = on;
    fresh.disabled = on;
    input.disabled = on;
    choices.querySelectorAll("button,input").forEach((b) => (b.disabled = on));
    status.classList.toggle("thinking", on);
    if (on) status.textContent = "正在连接…";
    else {
      stopProgress();
      if (status.textContent.startsWith("正在")) status.textContent = "";
    }
  }
  function stopProgress() {
    progressRequest = null;
    clearTimeout(progressTimer);
  }
  function watchProgress(requestId) {
    stopProgress();
    progressRequest = requestId;
    const poll = async () => {
      if (!active() || progressRequest !== requestId) return;
      try {
        const p = await api(
          `/api/agent/conversations/${conversationId}/progress?requestId=${requestId}`,
        );
        if (!active() || progressRequest !== requestId) return;
        if (p.steps?.length) status.textContent = p.steps.at(-1);
      } catch {
      }
      if (active() && progressRequest === requestId)
        progressTimer = setTimeout(poll, 900);
    };
    progressTimer = setTimeout(poll, 250);
  }
  function scroll() {
    log.lastElementChild?.scrollIntoView({
      block: "end",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }
  function bubble(text, who = "assistant") {
    const b = node("article", "agent-bubble " + who, text);
    log.append(b);
    return b;
  }
  function link(target, parent) {
    if (!target || !paths.test(target.route)) return;
    const b = node("button", "agent-chip");
    setIconLabel(b, target.title, "external");
    b.onclick = () => navigate(target.route);
    parent.append(b);
  }
  function showReply(reply, actionStatuses = {}) {
    const b = bubble(
      [reply.understanding && `已理解：${reply.understanding}`, reply.text]
        .filter(Boolean)
        .join("\n"),
    );
    if (reply.error) b.classList.add("agent-error");
    if (!reply.workflow?.length && reply.steps?.length) {
      const trace = node("details", "agent-trace");
      trace.append(node("summary", "", "处理步骤"));
      const list = node("ol");
      for (const label of reply.steps)
        list.append(node("li", "", label));
      trace.append(list);
      b.append(trace);
    }
    if (reply.sources?.length) {
      const sources = node("details", "agent-sources");
      sources.append(node("summary", "", "软件依据"));
      for (const s of reply.sources) link({ ...s, route: s.route }, sources);
      b.append(sources);
    }
    if (reply.navigation) link(reply.navigation, b);
    if (reply.action) {
      const a = reply.action,
        card = node("div", "agent-action");
      card.append(node("h3", "", a.title));
      for (const line of a.lines || []) card.append(node("p", "", line));
      const effective = actionStatuses[a.id] || "pending";
      if (effective === "pending") {
        const yes = node("button", "primary", "确认执行"),
          no = node("button", "agent-chip", "取消");
        setIconLabel(yes, '确认执行', 'check');
        const choose = async (decision) => {
          if (busy) return;
          yes.disabled = no.disabled = true;
          waiting(true);
          try {
            const requestId = crypto.randomUUID();
            watchProgress(requestId);
            const r = await api(
              `/api/agent/conversations/${conversationId}/actions/${a.id}`,
              { requestId, revision, decision },
            );
            if (!active()) return;
            revision = r.revision;
            showReply(r);
            renderQuestion(r.question);
            card.querySelector(".agent-action-buttons")?.remove();
            card.append(
              node(
                "span",
                "",
                r.actionResult?.status === "completed"
                  ? "已执行"
                  : r.actionResult?.status === "cancelled"
                    ? "已取消"
                    : "请核对结果",
              ),
            );
          } catch (e) {
            if (active()) {
              status.textContent = e.message;
              await load();
            }
          } finally {
            if (active()) {
              waiting(false);
              scroll();
            }
          }
        };
        yes.onclick = () => choose("confirm");
        no.onclick = () => choose("cancel");
        const buttons = node("div", "agent-action-buttons");
        buttons.append(yes, no);
        card.append(buttons);
      } else
        card.append(
          node(
            "span",
            "",
            {
              completed: "已执行",
              cancelled: "已取消",
              expired: "已过期",
              executing: "执行结果待核对",
              unknown: "执行结果待核对",
              failed: "未完成",
            }[effective] || effective,
          ),
        );
      b.append(card);
    }
    if (reply.question) renderQuestion(reply.question);
    if (reply.action && !reply.question) form.hidden = true;
  }
  function renderQuestion(q) {
    clearTimeout(continueTimer);
    question = q;
    choices.replaceChildren();
    if (q) choices.setAttribute("aria-label", q.text);
    else choices.removeAttribute("aria-label");
    form.hidden = !!q?.options?.length || q?.input === "date";
    input.placeholder =
      q?.input === "date"
        ? "例如 2026-10-20"
        : q?.input
          ? "填写你的回答…"
          : q
            ? "点选下面的选项，或输入取消"
            : "想去哪，或需要我做什么？";
    if (!q) return;
    const selected = new Set();
    if (q.options?.length) {
      choices.setAttribute("aria-label", q.text);
      for (const o of q.options) {
        const b = node("button", "agent-choice", o.label);
        b.type = "button";
        b.setAttribute("aria-pressed", "false");
        b.onclick = () => {
          if (busy) return;
          if (q.multi) {
            selected.has(o.id) ? selected.delete(o.id) : selected.add(o.id);
            b.setAttribute("aria-pressed", String(selected.has(o.id)));
          } else void sendMessage("", [o.id], o.label);
        };
        choices.append(b);
      }
      if (q.multi) {
        const done = node("button", "primary", "选好了");
        setIconLabel(done, '选好了', 'arrow');
        done.type = "button";
        done.onclick = () => {
          if (selected.size)
            void sendMessage(
              "",
              [...selected],
              q.options
                .filter((o) => selected.has(o.id))
                .map((o) => o.label)
                .join("、"),
            );
          else status.textContent = "至少选一项吧";
        };
        choices.append(done);
      }
    }
    if (q.input === "date") {
      const date = node("input", "agent-date");
      date.type = "date";
      date.required = true;
      date.setAttribute("aria-label", q.text);
      const next = node("button", "primary", "选好了");
      setIconLabel(next, '选好了', 'arrow');
      next.type = "button";
      next.onclick = () => {
        if (date.reportValidity()) void sendMessage(date.value);
      };
      choices.append(date, next);
    }
    if (form.hidden) {
      const custom = node("button", "agent-custom", "补充说明");
      custom.onclick = () => {
        form.hidden = false;
        input.placeholder = q.input
          ? "填写你的回答…"
          : "说明你的想法，或输入取消";
        input.focus();
      };
      choices.append(custom);
    }
    const cancel = node("button", "agent-custom", "取消这一步");
    cancel.onclick = () => void sendMessage("取消");
    choices.append(cancel);
    if (q.autoContinue && ['retryCity', 'retryWalkRoute'].includes(q.key)) {
      continueStarted ||= Date.now();
      if (Date.now() - continueStarted < 120000) {
        continueTimer = setTimeout(() => {
          if (active() && !busy && question?.id === q.id)
            void sendMessage('', [q.options[0].id], '继续自动安排', true);
          else if (active() && question?.id === q.id) renderQuestion(q);
        }, 1500);
      } else status.textContent = '景点准备得有些久，可以稍后点“继续安排”，已填写的信息会保留。';
    } else continueStarted = 0;
  }
  async function ensure() {
    if (!conversationId) {
      const c = await api("/api/agent/conversations", {});
      conversationId = c.id;
      revision = c.revision;
      sessionStorage.setItem(key, c.id);
    }
  }
  async function sendMessage(text, optionIds, label, automatic = false) {
    if (busy || (!text && !optionIds?.length)) return;
    waiting(true);
    log.querySelector(".agent-examples")?.remove();
    if (!automatic) { bubble(label || text, "user"); continueStarted = 0; }
    try {
      await ensure();
      const requestId = crypto.randomUUID();
      watchProgress(requestId);
      const r = await api(
        `/api/agent/conversations/${conversationId}/messages`,
        {
          requestId,
          revision,
          text: text || label || "",
          context,
          ...(question ? { questionId: question.id } : {}),
          ...(optionIds ? { optionIds } : {}),
        },
      );
      if (!active()) return;
      revision = r.revision;
      renderQuestion(r.question);
      if (!automatic || !r.question?.autoContinue || r.error) showReply(r);
      if (r.error) clearTimeout(continueTimer);
      input.value = "";
      if (
        r.classification?.capability === "navigate" &&
        r.navigation &&
        paths.test(r.navigation.route)
      )
        navigate(r.navigation.route);
    } catch (e) {
      if (active()) {
        bubble(e.message, "assistant agent-error");
        if (e.status === 409) await load();
      }
    } finally {
      if (active()) {
        waiting(false);
        scroll();
        if (!form.hidden && question?.input && !question.options?.length)
          input.focus({ preventScroll: true });
      }
    }
  }
  form.onsubmit = (e) => {
    e.preventDefault();
    void sendMessage(input.value.trim());
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  function welcome() {
    bubble("我陪你把旅行安排好。");
    const examples = node("div", "agent-examples");
    for (const text of [
      "我明早从北京去上海，玩两天，少走路，想看博物馆",
      "推荐当前行程附近的餐饮",
      "打开历史行程",
      "怎么规划行程？",
      "帮我安排去上海玩三天，喜欢建筑，避开拥挤",
    ]) {
      const b = node("button", "agent-chip", text);
      b.onclick = () => void sendMessage(text);
      examples.append(b);
    }
    log.append(examples);
  }
  fresh.onclick = () => {
    if (busy) return;
    clearTimeout(continueTimer);
    continueStarted = 0;
    conversationId = null;
    revision = 0;
    sessionStorage.removeItem(key);
    log.replaceChildren();
    renderQuestion(null);
    welcome();
  };
  memory.onclick = async () => {
    if (busy) return;
    waiting(true);
    try {
      const r = await api("/api/agent/memory");
      if (!active()) return;
      const b = bubble("我的旅行风格");
      for (const m of r.items) {
        const item = node("div", "agent-memory");
        item.append(
          node("b", "", m.label + " · " + m.valueLabel),
          node("p", "", m.active ? "长期记忆" : "已过期"),
        );
        const detail = node("details");
        detail.append(
          node("summary", "", "查看依据"),
          node("p", "", m.evidence),
          node(
            "p",
            "",
            `确认可信度 ${Math.round(m.confidence * 100)}% · 当前权重 ${Math.round(m.effectiveConfidence * 100)}%`,
          ),
        );
        item.append(detail);
        b.append(item);
      }
      if (!r.items.length) b.append(node("p", "", "还没有长期记忆。"));
      const change = node("button", "agent-chip", "调整旅行风格"),
        clear = node("button", "agent-chip", "清除长期记忆");
      change.onclick = () => void sendMessage("记住我的旅行风格");
      clear.onclick = () => void sendMessage("删除旅行风格记忆");
      b.append(change, clear);
      scroll();
    } catch (e) {
      if (active()) bubble(e.message, "assistant agent-error");
    } finally {
      if (active()) waiting(false);
    }
  };
  async function load() {
    if (!conversationId) {
      welcome();
      return;
    }
    try {
      const c = await api(`/api/agent/conversations/${conversationId}`);
      if (!active()) return;
      revision = c.revision;
      log.replaceChildren();
      const statuses = Object.fromEntries(
        c.actions.map((a) => [a.id, a.status]),
      );
      for (const m of c.messages) {
        bubble(m.input, "user");
        if (m.response) showReply(m.response, statuses);
        else bubble("上次处理的结果尚未确认，请先核对。");
      }
      renderQuestion(c.state.question);
      if (!c.messages.length) welcome();
      scroll();
    } catch (e) {
      if (!active()) return;
      if (e.status === 404) {
        conversationId = null;
        sessionStorage.removeItem(key);
        welcome();
      } else bubble(e.message, "assistant agent-error");
    }
  }
  void load();
  return () => {
    disposed = true;
    clearTimeout(continueTimer);
    stopProgress();
    content.classList.remove("agent-page");
  };
}
