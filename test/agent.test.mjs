import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import express from "express";
import cookieParser from "cookie-parser";
import pg from "pg";
import { classify, ruleIntent } from "../server/agent/intent.mjs";
import { explicitStyle, memoryPreferences } from "../server/agent/memory.mjs";
import { createKnowledge } from "../server/agent/knowledge.mjs";
import { allowedCall, createApiBridge } from "../server/agent/bridge.mjs";
import { createAgentEngine, parseDates } from "../server/agent/engine.mjs";
import { installAgentRoutes } from "../server/agent/routes.mjs";
import { createAccounts, requireUser, hashToken } from "../server/auth.mjs";
import { workflowAllows, guardWorkflow } from "../server/agent/workflow.mjs";
import { createProgress } from "../server/agent/progress.mjs";
import { travelFields, understandAnswer } from "../server/agent/dialogue.mjs";

test("dialogue accepts only grounded values and current option IDs from the interpreter", async () => {
  const q = {
    key: "originName",
    text: "从哪出发？",
    input: "text",
    options: [
      { id: "sh", label: "上海" },
      { id: "gz", label: "广州" },
    ],
  };
  const interpret = (text, output) =>
    understandAnswer(text, q, { enabled: true, model: async () => output });
  const answer = {
    kind: "answer",
    optionIndexes: [],
    value: "广州",
    evidence: "我在南方",
    confidence: 0.99,
  };
  assert.equal((await interpret("我在南方，猜猜看", answer)).kind, "unclear");
  assert.equal(
    (await interpret("我在南方，猜猜看", { ...answer, optionIndexes: [9] }))
      .kind,
    "unclear",
  );
  assert.equal(
    (await interpret("我在南方，猜猜看", { ...answer, optionIndexes: [0, 1] }))
      .kind,
    "unclear",
  );
  assert.equal(
    (
      await interpret("我在南方，猜猜看", {
        ...answer,
        optionIndexes: [1],
        evidence: "我在广州",
      })
    ).kind,
    "unclear",
  );
  assert.deepEqual(
    await interpret("广州吧，我想从那儿出发", {
      ...answer,
      evidence: "广州",
      optionIndexes: [1],
    }),
    { kind: "answer", optionIds: ["gz"] },
  );
  assert.equal(
    (await interpret("随便", { ...answer, optionIndexes: [0] })).kind,
    "unclear",
  );
  assert.deepEqual(travelFields("10月20日去，22日回"), {});
  assert.equal(travelFields("从上海出发，从广州出发").conflict, "origin");
});

test("model intent is a suggestion requiring a choice, never an executable instruction", async () => {
  let calls = 0;
  const e = createAgentEngine({
    query: async () => ({ rows: [] }),
    store: {},
    transaction: async () => {},
    knowledge: { search: async () => ({ documents: [] }) },
    modelEnabled: () => true,
    model: async () => ({
      intent: "operate",
      capability: "profile_update",
      confidence: 0.99,
      evidence: "请帮我调整个人称呼",
    }),
  });
  const ctx = {
    state: {},
    context: {},
    api: async () => {
      calls++;
    },
    user: { id: randomUUID() },
    c: { id: randomUUID() },
  };
  const r = await e.message(ctx, { text: "请帮我调整个人称呼" });
  assert.equal(r.question.key, "capability");
  assert.ok(r.question.options.some((o) => o.label.includes("昵称")));
  assert.equal(r.action, undefined);
  assert.equal(calls, 0);
});

test("workflow guard binds capability, phase, target, body and publication order", async () => {
  const id = randomUUID(),
    other = randomUUID();
  const state = {
    flow: { kind: "edit_trip", tripId: id, day: 0, edit: "移除故宫" },
  };
  assert.equal(
    workflowAllows({ state }, "POST", `/api/trips/${id}/assistant`, {
      day: 0,
      text: "移除故宫",
    }),
    true,
  );
  for (const [m, p, b] of [
    ["PATCH", `/api/trips/${id}`, { status: "completed" }],
    ["POST", `/api/trips/${other}/assistant`, { day: 0, text: "移除故宫" }],
    ["POST", "/api/discovery/publish", { kind: "journey", id }],
  ])
    assert.equal(workflowAllows({ state }, m, p, b), false);
  const action = { capability: "share_trip", payload: { tripId: id } };
  let called = 0;
  const ctx = {
    state: { flow: { kind: "share_trip", tripId: id } },
    api: async () => {
      called++;
    },
  };
  await assert.rejects(
    guardWorkflow(ctx, action).api("POST", "/api/discovery/publish", {
      kind: "journey",
      id,
    }),
    /顺序/,
  );
  const guarded = guardWorkflow(ctx, action);
  await guarded.api("GET", `/api/trips/${id}`);
  await guarded.api("POST", "/api/discovery/publish", { kind: "journey", id });
  await assert.rejects(
    guarded.api("POST", "/api/discovery/publish", { kind: "journey", id }),
    /顺序/,
  );
  assert.equal(called, 2);
});

test("uncertain request asks choices, model suggestions cannot start tools, foreign tasks have no tools", async () => {
  let called = 0;
  const e = createAgentEngine({
    query: async () => ({ rows: [] }),
    transaction: async () => {},
    store: {},
    knowledge: {
      answer: async () => ({ text: "知识库内容", intent: "software_question" }),
      search: async () => ({ documents: [] }),
    },
    modelEnabled: () => false,
  });
  const ctx = {
    state: {},
    context: {},
    api: async () => {
      called++;
    },
    user: { id: randomUUID() },
    c: { id: randomUUID() },
  };
  let r = await e.message(ctx, { text: "帮我改一下" });
  assert.equal(r.question.key, "intentMode");
  assert.equal(r.question.options.length, 3);
  r = await e.message(ctx, {
    text: "",
    questionId: r.question.id,
    optionIds: [r.question.options[0].id],
  });
  assert.equal(r.question.key, "capability");
  await assert.rejects(
    e.message(ctx, {
      text: "",
      questionId: r.question.id,
      optionIds: [randomUUID()],
    }),
  );
  assert.equal(
    (await e.message(ctx, { text: "帮我预订酒店并付款" })).intent,
    "other",
  );
  assert.equal(called, 0);
  assert.equal(ruleIntent("打开历史行程然后清空浏览历史").intent, "clarify");
});

test("progress isolates requests and reports only actual steps", () => {
  const p = createProgress(),
    report = p.start("a", "r1");
  report("正在识别需求…");
  report("正在识别需求…");
  assert.deepEqual(p.read("a", "r1").steps, ["正在识别需求…"]);
  assert.equal(p.read("a", "r2").status, "idle");
  p.finish("a");
  assert.equal(p.read("a", "r1").status, "completed");
});

test("agent publication uses the same discovery endpoint as the page after owned trip preview", async () => {
  const id = randomUUID(),
    calls = [],
    offers = [];
  const ctx = {
    state: {},
    user: { id: randomUUID() },
    c: { id: randomUUID() },
    context: { tripId: id },
    api: async (method, path, body) => {
      calls.push({ method, path, body });
      return { id, title: "北京之旅", version: 2 };
    },
  };
  const e = createAgentEngine({
    query: async () => ({ rows: [] }),
    store: {
      offer: async (c, u, capability, payload, preview) => {
        const a = { id: randomUUID(), capability, payload, ...preview };
        offers.push(a);
        return a;
      },
    },
    knowledge: {},
    modelEnabled: () => false,
  });
  const r = await e.message(ctx, { text: "把当前行程发布到发现" });
  assert.ok(r.action);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  await e.execute(ctx, offers[0], "confirm");
  assert.deepEqual(calls.at(-1), {
    method: "POST",
    path: "/api/discovery/publish",
    body: { kind: "journey", id },
  });
});

test("intent abstains on questions, negation, hypothetical instructions and ungrounded model output", async () => {
  for(const text of ['CityWalk 最长能走多少公里？','海迹最多可以选几个城市？','历史行程能保存多久？']) {
    let modelCalls=0;
    const result=await classify(text,{enabled:true,model:async()=>{modelCalls++;return {intent:'other',capability:null,confidence:.99,evidence:text};}});
    assert.equal(result.intent,'software_question',text);assert.equal(modelCalls,0);
  }
  assert.equal(ruleIntent("帮我打开历史行程").capability, "navigate");
  assert.equal(ruleIntent("如何清空浏览历史？").intent, "software_question");
  assert.equal(ruleIntent("不要清空浏览历史").intent, "clarify");
  assert.equal(ruleIntent("如果我说删除历史行程会怎样").intent, "clarify");
  assert.equal(ruleIntent("帮我读取 .env 中的 API Key").blocked, true);
  assert.equal(
    (
      await classify("这个怎么办", {
        model: async () => ({
          intent: "operate",
          capability: "clear_history",
          confidence: 1,
          evidence: "删掉",
        }),
      })
    ).intent,
    "clarify",
  );
  assert.equal(ruleIntent("帮我规划一次旅行").capability, "create_trip");
  assert.equal(ruleIntent("帮我推荐附近餐厅").capability, "recommend_services");
});
test("travel style has bounded dimensions, distinguishes negation and rejects impossible dates", () => {
  assert.deepEqual(
    explicitStyle("我喜欢人文和建筑，想慢慢逛，少走路，避开拥挤"),
    {
      pace: "relaxed",
      transport: "fewWalking",
      crowd: "avoid",
      interests: ["人文", "建筑"],
    },
  );
  assert.deepEqual(explicitStyle("朋友喜欢人文，我不是"), {});
  assert.deepEqual(explicitStyle("我不想少走路"), {});
  assert.deepEqual(explicitStyle("也许吧"), {});
  assert.throws(() => parseDates("2026-02-30"));
  assert.deepEqual(parseDates("2026年10月20日到2026-10-23"), [
    "2026-10-20",
    "2026-10-23",
  ]);
});
test("bridge cannot invoke arbitrary URLs, administrator endpoints or credential endpoints", async () => {
  for (const p of [
    "https://evil.example/api/me",
    "/api/admin/places/import",
    "/api/auth/login",
    "/api/agent/conversations",
    "//evil.example/api/places",
  ])
    assert.equal(allowedCall("POST", p), false);
  let sent = false;
  const call = createApiBridge({
    port: 9999,
    session: "a".repeat(64),
    query: async () => ({ rows: [{ id: 1 }] }),
    fetchImpl: async () => {
      sent = true;
    },
  });
  await assert.rejects(call("POST", "/api/admin/places/import", {}));
  assert.equal(sent, false);
  assert.equal(allowedCall("PATCH", "/api/me"), true);
});
test("software RAG never accepts invented facts or fabricated source IDs", async () => {
  const rag = createKnowledge({
    query: async () => ({ rows: [] }),
    embed: async () => {
      throw Error("offline");
    },
    enabled: () => true,
    model: async () => ({
      sentences: [{ quote: "酒店都是免费住宿", sourceId: "services" }],
    }),
  });
  const r = await rag.answer("餐饮住宿价格");
  assert.equal(r.retrieval, "lexical");
  assert.ok(r.sources.length);
  assert.doesNotMatch(r.text, /免费住宿/);
});
test("journey follows existing create → catalog → questions → generate endpoints and confirms both mutations", async () => {
  const user = { id: randomUUID() },
    c = { id: randomUUID() },
    state = {},
    calls = [],
    offers = [];
  const cities = {
    sh: { id: "sh", name: "上海", lat: 31, lng: 121 },
    bj: { id: "bj", name: "北京", lat: 39, lng: 116 },
  };
  const session = randomUUID(),
    tripId = randomUUID();
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith("/api/places"))
      return path.includes(encodeURIComponent("上海"))
        ? [cities.sh]
        : [cities.bj];
    if (path === "/api/journey/sessions")
      return { id: session, cities: [cities.bj] };
    if (path.includes("/cities/"))
      return {
        clusters: [
          {
            id: "g1",
            name: "皇城",
            memberCount: 4,
            members: [{ name: "故宫" }],
          },
        ],
      };
    if (path.endsWith("/questions"))
      return {
        defaults: {},
        questions: [
          {
            id: "pace",
            title: "怎样逛",
            type: "single",
            options: [{ label: "慢慢来", value: "relaxed" }],
          },
        ],
      };
    if (path.endsWith("/generate")) return { id: tripId, title: "北京之旅" };
    throw Error("Unexpected " + path);
  };
  const store = {
    offer: async (_c, _u, capability, payload, preview) => {
      const a = { id: randomUUID(), capability, payload, ...preview };
      offers.push(a);
      return a;
    },
  };
  const e = createAgentEngine({
    query: async () => ({ rows: [] }),
    transaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    store,
    knowledge: { answer: async () => ({ text: "help" }) },
    modelEnabled: () => false,
  });
  const ctx = { user, c, state, api, context: {} };
  let r = await e.message(ctx, { text: "帮我规划一次旅行" });
  assert.equal(r.question.key, "originName");
  const answer = async (text, indices) => {
    const q = state.question;
    return e.message(ctx, {
      text: text || "",
      questionId: q?.id,
      ...(indices ? { optionIds: indices.map((i) => q.options[i].id) } : {}),
    });
  };
  await answer("上海");
  assert.equal(state.question.key, "destinationName");
  await answer("北京");
  assert.equal(state.question.key, "cityNext");
  await answer("", [0]);
  await answer("2026-10-20");
  r = await answer("2026-10-21");
  assert.ok(r.action);
  assert.equal(
    calls.some((x) => x.path === "/api/journey/sessions"),
    false,
  );
  await e.execute(ctx, offers.at(-1), "confirm");
  await answer("", [0]);
  await answer("", [0]);
  r = await answer("", [0]);
  assert.ok(r.action);
  assert.equal(
    calls.some((x) => x.path.endsWith("/generate")),
    false,
  );
  r = await e.execute(ctx, offers.at(-1), "confirm");
  assert.equal(r.reply.tripId, tripId);
  assert.deepEqual(
    calls.filter((x) => !x.path.startsWith("/api/places")).map((x) => x.path),
    [
      "/api/journey/sessions",
      `/api/journey/sessions/${session}/cities/bj?async=1`,
      `/api/journey/sessions/${session}/questions`,
      `/api/journey/sessions/${session}/questions`,
      `/api/journey/sessions/${session}/generate`,
    ],
  );
  assert.equal(calls.at(-1).body.answers.pace, "relaxed");
  assert.deepEqual(calls.filter(c=>c.path.endsWith('/questions')).at(-1).body,{answers:{pace:'relaxed'}});
});

test("eating and lodging: actual candidates → preview → confirmation → same versioned save, refresh targets selected slot", async () => {
  const tid = randomUUID(),
    rid = randomUUID(),
    state = {},
    calls = [],
    offers = [];
  const e = createAgentEngine({
    query: async () => ({ rows: [] }),
    transaction: async () => {},
    store: {
      offer: async (c, u, capability, payload, preview) => {
        const a = { id: randomUUID(), capability, payload, ...preview };
        offers.push(a);
        return a;
      },
    },
    knowledge: {},
    modelEnabled: () => false,
  });
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === `/api/trips/${tid}`)
      return {
        id: tid,
        title: "北京",
        version: 3,
        plan: { days: [{ date: "2026-10-20", city: "北京" }] },
      };
    if (path.endsWith("/recommendations"))
      return {
        version: 3,
        slots: [
          {
            kind: "stay",
            id: "stay:0-0",
            recommendationId: rid,
            items: [{ id: "hotel1", name: "旅店甲", distanceMeters: 350 }],
          },
        ],
      };
    if (path.endsWith("/preview"))
      return { candidate: { id: "hotel1", name: "旅店甲" } };
    if (method === "PUT") return { id: tid };
    throw Error(path);
  };
  const ctx = {
    state,
    c: { id: randomUUID() },
    user: { id: randomUUID() },
    context: { tripId: tid },
    api,
  };
  let r = await e.message(ctx, { text: "推荐当前行程的酒店" });
  assert.equal(r.question.key, "day");
  const choose = async (n) => {
    const q = state.question;
    return e.message(ctx, {
      text: "",
      questionId: q.id,
      optionIds: [q.options[n].id],
    });
  };
  await choose(0);
  await choose(1);
  assert.equal(
    calls.filter((c) => c.path.endsWith("/recommendations")).at(-1).body
      .activeSlot,
    "stay:0-0",
  );
  r = await choose(0);
  assert.equal(r.action.title, "选入行程");
  assert.equal(
    calls.some((c) => c.method === "PUT"),
    false,
  );
  await e.execute(ctx, offers.at(-1), "confirm");
  assert.deepEqual(calls.at(-1).body, {
    version: 3,
    recommendationId: rid,
    placeId: "hotel1",
  });
  assert.match(calls.at(-2).path, /\/preview$/);
});
test("CityWalk uses catalog draft, validated cluster/stop choices and existing ordering before save", async () => {
  const state = {},
    calls = [],
    offers = [];
  const draft = randomUUID();
  const e = createAgentEngine({
    query: async () => ({ rows: [] }),
    transaction: async () => {},
    store: {
      offer: async (c, u, capability, payload, preview) => {
        const a = { id: randomUUID(), capability, payload, ...preview };
        offers.push(a);
        return a;
      },
    },
    knowledge: {},
    modelEnabled: () => false,
  });
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith("/api/places"))
      return [{ id: "sh", name: "上海", lat: 31, lng: 121 }];
    if (path.includes("/catalog/"))
      return {
        draftId: draft,
        clusters: [
          {
            id: "g",
            name: "江畔",
            members: [
              { id: "a", name: "甲", lat: 31, lng: 121 },
              { id: "b", name: "乙", lat: 31.01, lng: 121.01 },
            ],
          },
        ],
      };
    if (path === "/api/citywalk/preview")
      return {
        status: "ready",
        route: {
          status: "verified",
          distanceM: 1200,
          blocked: false,
          warning: false,
        },
      };
    if (path === "/api/citywalks") return { id: body.id, title: body.title };
    throw Error(path);
  };
  const ctx = {
    state,
    c: { id: randomUUID() },
    user: { id: randomUUID() },
    context: {},
    api,
  };
  let r = await e.message(ctx, { text: "创建 CityWalk" });
  assert.equal(r.question.key, "destinationName");
  const answer = async (text, ids) => {
    const q = state.question;
    return e.message(ctx, {
      text: text || "",
      questionId: q.id,
      ...(ids ? { optionIds: ids.map((n) => q.options[n].id) } : {}),
    });
  };
  await answer("上海");
  await answer("", [0]);
  await answer("", [0, 1]);
  await answer("", [0]);
  r = await answer("江畔漫步");
  assert.ok(r.action);
  assert.equal(
    calls.some((c) => c.method === "POST" && c.path === "/api/citywalks"),
    false,
  );
  assert.equal(calls.at(-1).path, "/api/citywalk/preview");
  await e.execute(ctx, offers.at(-1), "confirm");
  assert.equal(calls.at(-1).path, "/api/citywalks");
  assert.equal(calls.at(-1).body.draftId, draft);
  assert.deepEqual(calls.at(-1).body.stopIds, ["a", "b"]);
  assert.equal(calls.at(-1).body.updating, undefined);
});

test(
  "PostgreSQL + real HTTP: session isolation, confirmations, replay, conflict, unknown outcome, memory",
  { skip: process.env.TEST_AGENT !== "1" },
  async () => {
    const local = JSON.parse(
      await readFile(
        new URL("../.runtime/local.json", import.meta.url),
        "utf8",
      ),
    );
    const schema = "agent_test_" + randomBytes(6).toString("hex");
    const pool = new pg.Pool({
      host: "127.0.0.1",
      port: local.port,
      user: "seatraces",
      password: local.password,
      database: "seatraces",
      max: 8,
      options: `-c search_path=${schema}`,
    });
    const query = (sql, args) => pool.query(sql, args),
      transaction = async (fn) => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const r = await fn(c);
          await c.query("COMMIT");
          return r;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      };
    let server,
      writes = 0,
      simulateUnknown = false;
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      await query(
        `CREATE TABLE users(id uuid PRIMARY KEY,username varchar(32) UNIQUE NOT NULL,password_hash text NOT NULL,nickname varchar(40) NOT NULL,avatar varchar(12) NOT NULL DEFAULT '🌊',role text NOT NULL DEFAULT 'user',preferences jsonb NOT NULL DEFAULT '{}');CREATE TABLE sessions(token_hash text PRIMARY KEY,user_id uuid REFERENCES users(id),expires_at timestamptz);`,
      );
      await query(
        await readFile(
          new URL("../server/auth-schema.sql", import.meta.url),
          "utf8",
        ),
      );
      await query(
        await readFile(
          new URL("../server/agent/schema.sql", import.meta.url),
          "utf8",
        ),
      );
      const users = [];
      for (let i = 0; i < 2; i++) {
        const u = { id: randomUUID(), token: randomBytes(32).toString("hex") };
        users.push(u);
        await query(
          "INSERT INTO users(id,username,password_hash,nickname) VALUES($1,$2,'unused','original')",
          [u.id, "agent_" + i],
        );
        await query(
          "INSERT INTO sessions VALUES($1,$2,now()+interval '1 day')",
          [hashToken(u.token), u.id],
        );
      }
      const app = express();
      app.use(express.json(), cookieParser());
      app.use("/api", (req, res, next) =>
        !["GET", "HEAD"].includes(req.method) && req.get("X-Seatraces") !== "1"
          ? res.status(403).json({ error: "origin" })
          : next(),
      );
      const accounts = createAccounts({ query, transaction });
      app.use("/api", accounts.attach, accounts.gate, accounts.router);
      app.delete("/api/me/history", requireUser, (req, res) => {
        writes++;
        if (simulateUnknown)
          return res.status(503).json({ error: "lost response" });
        res.json({ ok: true });
      });
      const tripId = randomUUID();
      let tripVersion = 1;
      app.get("/api/trips", requireUser, (req, res) =>
        res.json(
          req.user.id === users[0].id
            ? [{ id: tripId, title: "北京", request: { start: "2026-10-20" } }]
            : [],
        ),
      );
      app.get("/api/trips/:id", requireUser, (req, res) =>
        req.user.id === users[0].id
          ? res.json({
              id: tripId,
              title: "北京",
              version: tripVersion,
              plan: { days: [{ date: "2026-10-20", city: "北京", stops: [] }] },
            })
          : res.status(404).json({ error: "行程不存在" }),
      );
      app.patch("/api/trips/:id", requireUser, (req, res) => {
        if (req.user.id !== users[0].id)
          return res.status(404).json({ error: "not found" });
        if (req.body.version !== tripVersion)
          return res.status(409).json({ error: "行程已更新" });
        writes++;
        res.json({ id: tripId, title: "北京", version: ++tripVersion });
      });
      installAgentRoutes(app, {
        auth: requireUser,
        query,
        transaction,
        port: () => server.address().port,
        modelEnabled: () => false,
        embed: async () => {
          throw Error("offline");
        },
      });
      app.use((err, req, res, next) =>
        res
          .status(err.status || (err.name === "ZodError" ? 400 : 500))
          .json({ error: err.message }),
      );
      server = app.listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      const base = "http://127.0.0.1:" + server.address().port;
      const req = async (user, path, body, method, headers = {}) => {
        const r = await fetch(base + path, {
          method: method || (body ? "POST" : "GET"),
          headers: {
            "Content-Type": "application/json",
            "X-Seatraces": "1",
            ...(user ? { Cookie: "st_session=" + user.token } : {}),
            ...headers,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: r.status, data: await r.json() };
      };
      const a = users[0],
        b = users[1];
      assert.equal((await req(null, "/api/agent/capabilities")).status, 401);
      assert.equal(
        (
          await req(a, "/api/agent/conversations", {}, "POST", {
            "X-Seatraces": "0",
          })
        ).status,
        403,
      );
      let c = (await req(a, "/api/agent/conversations", {})).data;
      assert.equal(
        (await req(b, "/api/agent/conversations/" + c.id)).status,
        404,
      );
      const progressPath = `/api/agent/conversations/${c.id}/progress?requestId=${randomUUID()}`;
      assert.equal((await req(null, progressPath)).status, 401);
      assert.equal((await req(b, progressPath)).status, 404);
      assert.equal((await req(a, progressPath)).data.status, "idle");
      const send = async (text, extra = {}) => {
        await query(
          "UPDATE agent_turns SET created_at=now()-interval '2 minutes'",
        );
        const r = await req(a, `/api/agent/conversations/${c.id}/messages`, {
          requestId: randomUUID(),
          revision: c.revision,
          text,
          ...extra,
        });
        assert.equal(r.status, 200);
        c.revision = r.data.revision;
        return r.data;
      };
      const decide = async (action, decision = "confirm") => {
        const body = {
          requestId: randomUUID(),
          revision: c.revision,
          decision,
        };
        const path = `/api/agent/conversations/${c.id}/actions/${action.id}`;
        const r = await req(a, path, body);
        c.revision = r.data.revision;
        return { r, body, path };
      };
      let r = await send("如何清空浏览历史？");
      assert.equal(r.intent, "software_question");
      assert.equal(writes, 0);
      r = await send("帮我清空浏览历史");
      assert.ok(r.action);
      assert.equal(writes, 0);
      const denied = await req(
        b,
        `/api/agent/conversations/${c.id}/actions/${r.action.id}`,
        { requestId: randomUUID(), revision: c.revision, decision: "confirm" },
      );
      assert.equal(denied.status, 404);
      const cancelled = await decide(r.action, "cancel");
      assert.equal(cancelled.r.data.actionResult.status, "cancelled");
      assert.equal(writes, 0);
      r = await send("帮我清空浏览历史");
      const done = await decide(r.action);
      assert.equal(writes, 1);
      assert.equal(done.r.data.actionResult.status, "completed");
      const replay = await req(a, done.path, done.body);
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.data, done.r.data);
      assert.equal(writes, 1);
      r = await send("把昵称改成小海");
      assert.ok(r.action);
      await decide(r.action);
      assert.equal(
        (await query("SELECT nickname FROM users WHERE id=$1", [a.id])).rows[0]
          .nickname,
        "小海",
      );
      assert.equal(
        (await query("SELECT nickname FROM users WHERE id=$1", [b.id])).rows[0]
          .nickname,
        "original",
      );
      r = await send("标记当前行程已完成", {
        context: { page: "home", tripId },
      });
      assert.ok(r.action);
      tripVersion++;
      const stale = await decide(r.action);
      assert.equal(stale.r.data.actionResult.status, "failed");
      assert.equal(writes, 1);
      r = await send("我喜欢人文和建筑，想慢慢逛");
      assert.equal(r.question.key, "scope");
      r = await send("", {
        questionId: r.question.id,
        optionIds: [r.question.options[1].id],
      });
      assert.ok(r.action);
      await decide(r.action);
      assert.deepEqual(await memoryPreferences(query, a.id), {
        interests: ["人文", "建筑"],
        pace: "relaxed",
      });
      assert.deepEqual(await memoryPreferences(query, b.id), {});
      r = await send("帮我规划一次旅行");
      assert.equal(r.question.key, "originName");
      const bad = await send("", {
        questionId: r.question.id,
        optionIds: [randomUUID()],
      });
      assert.equal(bad.error, true);
      await send("取消");
      simulateUnknown = true;
      r = await send("帮我清空浏览历史");
      const uncertain = await decide(r.action);
      assert.equal(uncertain.r.data.actionResult.status, "unknown");
      assert.equal(writes, 2);
      const repeated = await req(a, uncertain.path, {
        ...uncertain.body,
        requestId: randomUUID(),
        revision: c.revision,
      });
      assert.equal(repeated.data.error, true);
      assert.equal(writes, 2);
      assert.ok(
        (await query("SELECT count(*)::int n FROM agent_tool_calls")).rows[0]
          .n >= 4,
      );
    } finally {
      if (server) await new Promise((r) => server.close(r));
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    }
  },
);
