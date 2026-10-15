import { z } from "zod";
import { createAgentStore, fail } from "./store.mjs";
import { createAgentEngine, cleanContext, publicState } from "./engine.mjs";
import { createApiBridge } from "./bridge.mjs";
import { createKnowledge, knowledgeVersion } from "./knowledge.mjs";
import { llmJSON } from "../integrations/deepseek.mjs";
import { readMemory } from "./memory.mjs";
import { capabilities } from "./catalog.mjs";
import { workflows } from "./workflow.mjs";
import { createProgress } from "./progress.mjs";

const messageInput = z
  .object({
    requestId: z.uuid(),
    revision: z.number().int().min(0),
    text: z.string().trim().max(1500).default(""),
    questionId: z.uuid().optional(),
    optionIds: z.array(z.uuid()).max(100).optional(),
    context: z.unknown().optional(),
  })
  .strict()
  .refine((v) => v.text.length || v.optionIds?.length, "请输入消息或选择选项");
const decisionInput = z
  .object({
    requestId: z.uuid(),
    revision: z.number().int().min(0),
    decision: z.enum(["confirm", "cancel"]),
  })
  .strict();
// Credentials never enter chat storage or model prompts. Sensitive account forms remain in the account page.
const containsSecret = (s) =>
  /-----BEGIN [^-]*PRIVATE KEY-----|(?:sk-[a-zA-Z0-9]{20,})|(?:密码|password|token|api[_ ]?key|authorization)\s*[:：=]\s*\S{4,}/i.test(
    s,
  );
export function installAgentRoutes(
  app,
  {
    auth,
    query,
    transaction,
    port,
    model = llmJSON,
    embed,
    modelEnabled,
    bridgeFactory = createApiBridge,
  },
) {
  const store = createAgentStore({ query, transaction });
  const progress = createProgress();
  const knowledge = createKnowledge({
    query,
    model,
    ...(embed ? { embed } : {}),
    ...(modelEnabled ? { enabled: modelEnabled } : {}),
  });
  const engine = createAgentEngine({
    query,
    transaction,
    store,
    knowledge,
    model,
    ...(modelEnabled ? { modelEnabled } : {}),
  });
  const contextFor = (req, c, state) => ({
    c,
    state,
    user: req.user,
    context: state.context || {},
    api: bridgeFactory({
      port,
      session: req.cookies?.st_session,
      query,
      userId: req.user.id,
      conversationId: c.id,
    }),
  });
  app.get("/api/agent/capabilities", auth, (req, res) =>
    res.json({
      version: "agent/1",
      capabilities,
      knowledgeVersion,
      confirmationRequired: true,
      intentCategories: ["operate", "software_question", "other"],
      workflows,
    }),
  );
  app.get("/api/agent/memory", auth, async (req, res) =>
    res.json({ items: await readMemory(query, req.user.id) }),
  );
  app.get("/api/agent/conversations/:id/progress", auth, async (req, res) => {
    const id = z.uuid().parse(req.params.id),
      requestId = z.uuid().parse(req.query.requestId);
    await store.own(id, req.user.id);
    res.set("Cache-Control", "no-store").json(progress.read(id, requestId));
  });
  app.post("/api/agent/conversations", auth, async (req, res) => {
    z.object({}).strict().parse(req.body);
    const c = await store.start(req.user.id);
    res
      .status(201)
      .json({ id: c.id, revision: 0, messages: [], state: publicState({}) });
  });
  app.get("/api/agent/conversations/:id", auth, async (req, res) => {
    const c = await store.own(z.uuid().parse(req.params.id), req.user.id);
    const rows = (
      await query(
        "SELECT id,input,response,status,created_at FROM agent_turns WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 60",
        [c.id, req.user.id],
      )
    ).rows.reverse();
    const actions = (
      await query(
        "SELECT id,preview,status,expires_at FROM agent_actions WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 30",
        [c.id, req.user.id],
      )
    ).rows;
    res.json({
      id: c.id,
      revision: c.revision,
      state: publicState(c.state),
      messages: rows,
      actions: actions.map((a) => ({
        ...a,
        status:
          a.status === "pending" && new Date(a.expires_at) < new Date()
            ? "expired"
            : a.status,
      })),
      busy: Boolean(c.busy_until && new Date(c.busy_until) > new Date()),
    });
  });
  app.post("/api/agent/conversations/:id/messages", auth, async (req, res) => {
    const b = messageInput.parse(req.body),
      id = z.uuid().parse(req.params.id);
    if (containsSecret(b.text))
      throw fail("请勿在对话中提交密码或密钥；请在账号页面操作");
    const context = cleanContext(b.context || {});
    const run = await store.begin(
      id,
      req.user.id,
      b.requestId,
      b.text || "选择了当前问题的选项",
      b.revision,
    );
    if (run.cached) return res.json(run.cached);
    const { conversation: c, token } = run,
      state = structuredClone(c.state),
      before = structuredClone(c.state);
    state.context = context;
    const report = progress.start(id, b.requestId);
    try {
      const reply = await engine.message(
        { ...contextFor(req, c, state), progress: report },
        b,
      );
      const response = await store.finish(c, req.user.id, token, state, {
        ...reply,
        steps: progress.read(id, b.requestId).steps,
      });
      progress.finish(id);
      return res.json(response);
    } catch (e) {
      progress.finish(id, true);
      const safe =
        e instanceof z.ZodError
          ? "填写的内容不符合要求，请重新填写。"
          : e.status
            ? e.message
            : "暂时没有完成，请重试。";
      return res.json(
        await store.finish(
          c,
          req.user.id,
          token,
          before,
          {
            text: safe,
            intent: "clarify",
            error: true,
            ...(before.question
              ? { question: publicState(before).question }
              : {}),
          },
          "failed",
        ),
      );
    }
  });
  app.post(
    "/api/agent/conversations/:id/actions/:actionId",
    auth,
    async (req, res) => {
      const b = decisionInput.parse(req.body),
        id = z.uuid().parse(req.params.id),
        actionId = z.uuid().parse(req.params.actionId);
      const run = await store.begin(
        id,
        req.user.id,
        b.requestId,
        b.decision === "confirm" ? "确认执行" : "取消操作",
        b.revision,
      );
      if (run.cached) return res.json(run.cached);
      const { conversation: c, token } = run,
        state = structuredClone(c.state);
      let claimed = false;
      const report = progress.start(id, b.requestId);
      try {
        // An old confirmation cannot replace the state of a newer conversation flow.
        if (state.pendingAction !== actionId)
          throw fail("当前待确认操作已变化，请重新预览", 409);
        const action = await store.claim(actionId, c, req.user.id, b.decision);
        claimed = b.decision === "confirm" && !action.replayed;
        const result = action.replayed
          ? { state, reply: action.result.reply }
          : await engine.execute(
              { ...contextFor(req, c, state), progress: report },
              action,
              b.decision,
            );
        // Persist outcome before replying. Retrying a completed action never calls a business endpoint again.
        await query(
          "UPDATE agent_actions SET status=$2,result=$3,finished_at=now() WHERE id=$1 AND user_id=$4",
          [
            actionId,
            b.decision === "confirm" ? "completed" : "cancelled",
            JSON.stringify(result),
            req.user.id,
          ],
        );
        const response = await store.finish(
          c,
          req.user.id,
          token,
          result.state,
          {
            ...result.reply,
            steps: progress.read(id, b.requestId).steps,
            actionResult: {
              id: actionId,
              status: b.decision === "confirm" ? "completed" : "cancelled",
            },
          },
        );
        progress.finish(id);
        return res.json(response);
      } catch (e) {
        progress.finish(id, true);
        const unknown = claimed && (!e.status || e.status >= 500);
        if (claimed)
          await query(
            "UPDATE agent_actions SET status=$2,finished_at=now() WHERE id=$1 AND user_id=$3",
            [actionId, unknown ? "unknown" : "failed", req.user.id],
          );
        delete state.pendingAction;
        delete state.flow;
        delete state.question;
        return res.json(
          await store.finish(
            c,
            req.user.id,
            token,
            state,
            {
              text: unknown
                ? "未收到确定结果，请先打开对应页面核对；这项操作不会自动重试。"
                : e.status
                  ? e.message
                  : "操作没有完成，请重新发起。",
              error: true,
              intent: "operate",
              actionResult: {
                id: actionId,
                status: unknown ? "unknown" : "failed",
              },
            },
            "failed",
          ),
        );
      }
    },
  );
  return { knowledge };
}
