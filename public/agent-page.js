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
    disposed = false;
  const top = node("div", "agent-toolbar"),
    fresh = node("button", "agent-chip", "＋ 新对话"),
    memory = node("button", "agent-chip", "我的旅行风格");
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
  input.placeholder = "想去哪，或需要我做什么？";
  input.setAttribute("aria-label", "发给问 AI 的消息");
  const send = node("button", "primary", "发送 ↑");
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
    status.textContent = on ? "想一想，再安排…" : "";
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
    const b = node("button", "agent-chip", target.title + " ↗");
    b.onclick = () => navigate(target.route);
    parent.append(b);
  }
  function showReply(reply, actionStatuses = {}) {
    const b = bubble(reply.text || "");
    if (reply.error) b.classList.add("agent-error");
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
        const yes = node("button", "primary", "确认执行 ✓"),
          no = node("button", "agent-chip", "取消");
        const choose = async (decision) => {
          if (busy) return;
          yes.disabled = no.disabled = true;
          waiting(true);
          try {
            const r = await api(
              `/api/agent/conversations/${conversationId}/actions/${a.id}`,
              { requestId: crypto.randomUUID(), revision, decision },
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
  }
  function renderQuestion(q) {
    question = q;
    choices.replaceChildren();
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
        const done = node("button", "primary", "选好了 →");
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
  }
  async function ensure() {
    if (!conversationId) {
      const c = await api("/api/agent/conversations", {});
      conversationId = c.id;
      revision = c.revision;
      sessionStorage.setItem(key, c.id);
    }
  }
  async function sendMessage(text, optionIds, label) {
    if (busy || (!text && !optionIds?.length)) return;
    waiting(true);
    bubble(label || text, "user");
    try {
      await ensure();
      const r = await api(
        `/api/agent/conversations/${conversationId}/messages`,
        {
          requestId: crypto.randomUUID(),
          revision,
          text,
          context,
          ...(question ? { questionId: question.id } : {}),
          ...(optionIds ? { optionIds } : {}),
        },
      );
      if (!active()) return;
      revision = r.revision;
      renderQuestion(r.question);
      showReply(r);
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
      "帮我规划一次旅行",
      "推荐当前行程附近的餐饮",
      "打开历史行程",
      "怎么规划行程？",
      "我喜欢人文和建筑，想慢慢逛",
    ]) {
      const b = node("button", "agent-chip", text);
      b.onclick = () => void sendMessage(text);
      examples.append(b);
    }
    log.append(examples);
  }
  fresh.onclick = () => {
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
    content.classList.remove("agent-page");
  };
}
