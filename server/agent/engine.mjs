import { travelTiming, tripPreferences } from "./travel-language.mjs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pages, capabilities } from "./catalog.mjs";
import { classify, pageFromText } from "./intent.mjs";
import {
  explicitStyle,
  styleSchema,
  styleLabels,
  labelValue,
  readMemory,
  memoryPreferences,
  saveMemory,
} from "./memory.mjs";
import { journeyAnswers } from "../services/journey-draft.mjs";
import { datesBetween, interests } from "../planner.mjs";
import { fail } from "./store.mjs";
import { orderWalk } from "../../public/citywalk-route.js";
import { guardWorkflow, workflows } from "./workflow.mjs";
import {
  travelFields,
  understandAnswer,
  bypassConfirmation,
} from "./dialogue.mjs";

const compactTrip = (t) => ({
  id: t.id,
  title: t.title,
  start: t.request?.start,
  end: t.request?.end,
});
const option = (label, data) => ({
  id: randomUUID(),
  label: String(label).slice(0, 180),
  data,
});
const displayReply = (text, extra = {}) => ({
  text,
  intent: "operate",
  ...extra,
});
export function cleanContext(input = {}) {
  return z
    .object({
      page: z.enum([...Object.keys(pages), "agent", "services"]).optional(),
      tripId: z.uuid().optional(),
      day: z.number().int().min(0).max(29).optional(),
    })
    .strict()
    .parse(input);
}
export function parseDates(text) {
  const dates = [
    ...text.matchAll(/(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})日?/g),
  ].map((m) => `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  for (const d of dates) datesBetween(d, d);
  return dates;
}
export function publicState(state) {
  const q = state.question;
  return {
    flow: state.flow?.kind || null,
    question: q
      ? {
          id: q.id,
          key: q.key,
          text: q.text,
          multi: q.multi || false,
          options: q.options.map(({ id, label }) => ({ id, label })),
          input: q.input || null,
        }
      : null,
  };
}

export function createAgentEngine({
  query,
  transaction,
  store,
  knowledge,
  model,
  modelEnabled = () => Boolean(process.env.DEEPSEEK_API_KEY),
  now = () => new Date(),
}) {
  function ask(
    state,
    key,
    text,
    options = [],
    { multi = false, input = null } = {},
  ) {
    state.question = {
      id: randomUUID(),
      key,
      text,
      options: options.map((o) => option(o.label, o.data)),
      multi,
      input,
    };
    return displayReply(text, {
      question: publicState(state).question,
      workflow: workflows[state.flow?.kind] || null,
    });
  }
  const textQuestion = (s, key, text, input = "text") =>
    ask(s, key, text, [], { input });
  const cityQuestion = (s, key, text) =>
    ask(
      s,
      key,
      text,
      ["北京", "上海", "广州", "深圳", "杭州"].map((name) => ({
        label: name,
        data: name,
      })),
      { input: "text" },
    );
  async function softwareAnswer(ctx, text) {
    ctx.progress?.("正在检索软件知识…");
    const reply = await knowledge.answer(text);
    if (reply.sources?.length === 0 && !ctx.state.question) {
      ctx.state.flow = { kind: "software_help" };
      return {
        ...ask(
          ctx.state,
          "knowledgeTopic",
          "你想了解哪个功能？",
          Object.entries(pages).map(([id, p]) => ({
            label: p.title,
            data: id,
          })),
          { input: "text" },
        ),
        intent: "software_question",
        retrieval: reply.retrieval,
      };
    }
    return reply;
  }
  function switchTask(s, text) {
    s.switchRequest = {
      text,
      flow: structuredClone(s.flow),
      question: structuredClone(s.question),
    };
    s.flow = { kind: "switch_task" };
    return ask(s, "switchDecision", "要先切换到这件事吗？", [
      { label: "切换到新任务", data: "switch" },
      { label: "继续当前任务", data: "stay" },
    ]);
  }
  async function collectTravel(ctx, text, key) {
    const f = ctx.state.flow;
    if (!["create_trip", "create_citywalk"].includes(f?.kind)) return null;
    const fields = travelFields(text, key);
    const timing =
      f.kind === "create_trip"
        ? travelTiming(text, {
            now: now(),
            timeZone: "Asia/Shanghai",
            start: f.start,
            days: f.durationDays,
            questionKey: key,
          })
        : {};
    const style =
      f.kind === "create_trip"
        ? tripPreferences(text)
        : { values: {}, conflicts: {} };
    if (
      !Object.keys(fields).length &&
      !Object.keys(timing).length &&
      !Object.keys(style.values).length &&
      !Object.keys(style.conflicts).length
    )
      return null;
    if (timing.invalid) {
      delete fields.start;
      delete fields.end;
    }
    if (timing.start) fields.start = timing.start;
    if (timing.end) fields.end = timing.end;
    if (timing.days) f.durationDays = timing.days;
    f.answers = { ...f.answers, ...style.values };
    f.explicitAnswerKeys = [
      ...new Set([
        ...(f.explicitAnswerKeys || []),
        ...Object.keys(style.values),
      ]),
    ];
    if (fields.start) parseDates(fields.start);
    if (fields.end) parseDates(fields.end);
    if (
      f.sessionId &&
      ["originName", "destinationName", "start", "end"].some(
        (k) => fields[k] !== undefined && fields[k] !== f[k],
      )
    )
      for (const k of [
        "sessionId",
        "catalog",
        "selections",
        "questions",
        "answered",
        "answering",
        "selectingCity",
      ])
        delete f[k];
    if (fields.conflict) {
      delete f.origin;
      delete f.originName;
      return ask(
        ctx.state,
        "originName",
        "这句话有两个出发地，这次从哪座城市出发？",
        fields.candidates.map((name) => ({ label: name, data: name })),
        { input: "text" },
      );
    }
    if (fields.originName) {
      delete f.origin;
      f.originName = fields.originName;
    }
    if (fields.destinationName) {
      for (const k of [
        "cities",
        "citiesDone",
        "walkCity",
        "walkCatalog",
        "walkClusters",
        "stopIds",
        "startId",
        "draftId",
      ])
        delete f[k];
      f.destinationName = fields.destinationName;
      if (
        f.kind === "create_trip" &&
        !/(和|或|、|然后|再去)/.test(fields.destinationName)
      )
        f.citiesDone = true;
    }
    if (fields.start) f.start = fields.start;
    if (fields.end) f.end = fields.end;
    delete ctx.state.question;
    if (timing.conflict) {
      const c = timing.conflict;
      delete f[c.key];
      if (c.key === "duration" || c.key === "start") delete f.end;
      delete f.durationDays;
      return ask(
        ctx.state,
        c.key,
        c.text,
        c.options.map((value) => ({
          label: c.key === "duration" ? value + " 天" : value,
          data: value,
        })),
        { input: c.key === "duration" ? "text" : "date" },
      );
    }
    const preferenceConflict = Object.entries(style.conflicts)[0];
    if (preferenceConflict) {
      const [dimension, values] = preferenceConflict;
      f.styleConflict = dimension;
      return ask(
        ctx.state,
        "stylePriority",
        "这次优先满足哪一项？",
        values.map((value) => ({ label: labelValue(value), data: value })),
      );
    }
    const understood = [
      fields.originName && `从${fields.originName}出发`,
      fields.destinationName && `去${fields.destinationName}`,
      fields.start && `${fields.start}出发`,
      fields.end && `${fields.end}返回`,
      ...Object.entries(style.values).map(
        ([k, v]) => `${styleLabels[k]}：${labelValue(v)}`,
      ),
    ]
      .filter(Boolean)
      .join("，");
    if (f.start && f.end && f.end < f.start) {
      delete f.end;
      return {
        ...textQuestion(
          ctx.state,
          "end",
          "返回日期早于出发日期，请重新选择返回日期。",
          "date",
        ),
        understanding: understood,
      };
    }
    return { ...(await advance(ctx)), understanding: understood };
  }
  async function prepare(ctx, capability, payload, title, lines, after) {
    if (!workflows[capability] || ctx.state.flow?.kind !== capability)
      throw fail("当前流程不允许准备这项操作", 403);
    ctx.progress?.("正在准备操作预览…");
    const action = await store.offer(
      ctx.c,
      ctx.user.id,
      capability,
      { ...payload, after },
      {
        title,
        lines,
        screen:
          capabilities.find((c) => c.id === capability)?.screen || "问 AI",
        effect: capability,
      },
    );
    ctx.state.pendingAction = action.id;
    delete ctx.state.question;
    return displayReply("请确认这一步。", {
      action,
      workflow: workflows[capability],
    });
  }
  async function trip(ctx) {
    const f = ctx.state.flow;
    if (!f.tripId) {
      const rows = await ctx.api(
        "GET",
        "/api/trips?summary=1&limit=20&offset=0",
      );
      if (!rows.length) {
        delete ctx.state.flow;
        return {
          reply: displayReply("还没有保存的行程。可以先制订一份。", {
            navigation: { route: "/home", title: "旅行" },
          }),
        };
      }
      return {
        reply: ask(
          ctx.state,
          "tripId",
          "要处理哪份行程？",
          rows.map((t) => ({
            label: `${t.title} · ${t.request?.start || ""}`,
            data: t.id,
          })),
        ),
      };
    }
    const value = await ctx.api("GET", `/api/trips/${f.tripId}`);
    return { value };
  }
  async function needDay(ctx, t) {
    if (
      ctx.state.flow.day === undefined &&
      ctx.context.tripId === t.id &&
      Number.isInteger(ctx.context.day) &&
      t.plan.days[ctx.context.day]
    )
      ctx.state.flow.day = ctx.context.day;
    if (ctx.state.flow.day === undefined || !t.plan.days[ctx.state.flow.day])
      return ask(
        ctx.state,
        "day",
        "选择哪一天？",
        t.plan.days.map((d, i) => ({
          label: `Day ${i + 1} · ${d.date} · ${d.city}`,
          data: i,
        })),
      );
  }
  async function findCities(ctx, name, key) {
    const rows = await ctx.api(
      "GET",
      "/api/places?category=city&q=" + encodeURIComponent(name),
    );
    const unique = new Map();
    for (const c of rows)
      if (!unique.has(c.country + ":" + c.name.replace(/市$/, "")))
        unique.set(c.country + ":" + c.name.replace(/市$/, ""), c);
    const values = [...unique.values()].slice(0, 12);
    if (!values.length)
      return textQuestion(
        ctx.state,
        key,
        `没有找到“${name}”，换个城市名称试试。`,
      );
    const cityData = (c) => ({
      id: c.id,
      name: c.name,
      country: c.country,
      lat: Number(c.lat),
      lng: Number(c.lng),
    });
    const normalize = (name) => name.trim().toLowerCase().replace(/市$/, "");
    const exact = values.filter((c) => normalize(c.name) === normalize(name));
    if (
      exact.length === 1 &&
      Number.isFinite(Number(exact[0].lat)) &&
      Number.isFinite(Number(exact[0].lng))
    ) {
      applyAnswer(ctx.state, key, cityData(exact[0]), name);
      return advance(ctx);
    }
    return ask(
      ctx.state,
      key,
      "确认一下是哪座城市。",
      (exact.length ? exact : values).map((c) => ({
        label: `${c.name} · ${c.province || c.country}`,
        data: cityData(c),
      })),
    );
  }
  async function start(ctx, intent, text) {
    ctx.state.flow = { kind: intent.capability, original: text };
    const f = ctx.state.flow;
    if (
      [
        "edit_trip",
        "trip_status",
        "trip_restore",
        "recommend_services",
        "share_trip",
      ].includes(f.kind) &&
      ctx.context.tripId &&
      /(当前|这份|这次|这个|附近|沿途)/.test(text)
    )
      f.tripId = ctx.context.tripId;
    if (f.kind === "recommend_services")
      f.serviceKind = /(住宿|酒店|旅店|民宿)/.test(text)
        ? "stay"
        : /(餐饮|餐厅|饭店|吃饭)/.test(text)
          ? "dining"
          : undefined;
    const day = text.match(/(?:第\s*|Day\s*)(\d{1,2})(?:\s*天)?/i);
    if (day && Number(day[1]) > 0) f.day = Number(day[1]) - 1;
    if (f.kind === "profile_update")
      f.nickname = text
        .match(
          /(?:改成|改为|叫做|设为)\s*[“"「]?([^”"」。，！!?？]{1,40})/,
        )?.[1]
        ?.trim();
    if (f.kind === "trip_status")
      f.status = /已完成|完成了/.test(text)
        ? "completed"
        : /计划中/.test(text)
          ? "planned"
          : undefined;
    if (f.kind === "navigate")
      f.page = intent.page || pageFromText(text) || ctx.context.page;
    if (f.kind === "memory") f.style = explicitStyle(text);
    if (f.kind === "create_citywalk")
      f.walkMode = /(编辑|修改)/.test(text) ? "edit" : "create";
    if (f.kind === "post_reaction") {
      f.reaction = /收藏/.test(text)
        ? "save"
        : /推荐/.test(text)
          ? "recommend"
          : "like";
      f.active = !/取消/.test(text);
    }
    if (f.kind === "create_trip") {
      const ds = parseDates(text);
      if (ds.length >= 2) {
        f.start = ds[0];
        f.end = ds[1];
      }
      f.originName = text.match(/从\s*([^，。\s]{1,20}?)(?:出发|到|去)/)?.[1];
      f.destinationName = text.match(
        /(?:到|去)\s*([^，。\s\d]{1,20}?)(?:旅游|旅行|游玩|玩|出发|[，。\s]|$)/,
      )?.[1];
      f.answers = {
        ...(await memoryPreferences(query, ctx.user.id)),
        ...(ctx.state.style || {}),
      };
      const collected = await collectTravel(ctx, text);
      if (collected) return collected;
      if (f.start && f.end && f.end < f.start) {
        delete f.end;
        return textQuestion(
          ctx.state,
          "end",
          "返回日期早于出发日期，请重新选择返回日期。",
          "date",
        );
      }
    }
    return advance(ctx);
  }
  async function advance(ctx) {
    const { state: s } = ctx,
      f = s.flow;
    if (!f) return displayReply("想先做哪件事？");
    if (f.kind === "software_help") {
      const topic = f.knowledgeTopic;
      delete s.flow;
      return softwareAnswer(ctx, `${pages[topic]?.title || topic}怎么使用？`);
    }
    if (f.kind === "clarify") {
      if (!f.intentMode)
        return ask(
          s,
          "intentMode",
          "你希望我怎样帮忙？",
          [
            { label: "帮我操作软件", data: "operate" },
            { label: "解释软件功能", data: "software_question" },
            { label: "只是聊一聊", data: "other" },
          ],
          { input: "text" },
        );
      if (f.intentMode === "software_question") {
        delete s.flow;
        return softwareAnswer(ctx, f.original);
      }
      if (f.intentMode === "other") {
        delete s.flow;
        return {
          text: "可以简单聊聊；安排旅行时，我能帮你使用海迹里的功能。",
          intent: "other",
        };
      }
      if (f.capability === "more") {
        delete f.capability;
        f.showAll = true;
      }
      if (!f.capability) {
        const common = [
          "create_trip",
          "edit_trip",
          "recommend_services",
          "navigate",
          "create_citywalk",
          "memory",
        ];
        const choices = capabilities.filter(
          (c) =>
            f.showAll ||
            (f.suggested ? c.id === f.suggested : common.includes(c.id)),
        );
        return ask(
          s,
          "capability",
          f.suggested && !f.showAll ? "你想做的是这件事吗？" : "想做哪件事？",
          [
            ...choices.map((c) => ({ label: c.title, data: c.id })),
            ...(!f.showAll ? [{ label: "其他软件操作", data: "more" }] : []),
          ],
          { input: "text" },
        );
      }
      return start(ctx, { capability: f.capability }, f.original);
    }
    if (f.kind === "navigate") {
      const p = pages[f.page];
      if (!p)
        return ask(
          s,
          "page",
          "要去哪个页面？",
          Object.entries(pages).map(([id, p]) => ({
            label: p.title,
            data: id,
          })),
        );
      delete s.flow;
      return displayReply(`打开${p.title}。`, {
        navigation: { route: p.route, title: p.title, level: p.level },
      });
    }
    if (f.kind === "account_secure") {
      delete s.flow;
      return displayReply("请在账号页面完成这一步。", {
        navigation: { route: "/account", title: "我的账号", level: 2 },
        handoff: true,
      });
    }
    if (f.kind === "profile_update") {
      if (!f.nickname) return textQuestion(s, "nickname", "想把昵称改成什么？");
      z.string().trim().min(1).max(40).parse(f.nickname);
      return prepare(ctx, f.kind, { nickname: f.nickname }, "修改昵称", [
        `新昵称：${f.nickname}`,
      ]);
    }
    if (f.kind === "clear_history")
      return prepare(ctx, f.kind, {}, "清空浏览历史", [
        "删除本人全部浏览记录",
        "此操作无法恢复，已保存的行程不受影响",
      ]);
    if (f.kind === "forget_memory") {
      const rows = await readMemory(query, ctx.user.id);
      if (!rows.length) {
        delete s.flow;
        return displayReply("目前没有长期旅行记忆。");
      }
      return prepare(
        ctx,
        f.kind,
        {
          versions: Object.fromEntries(
            rows.map((r) => [r.dimension, r.version]),
          ),
        },
        "清除旅行风格记忆",
        rows.map((r) => `${r.label}：${r.valueLabel}`),
      );
    }
    if (f.kind === "memory") {
      if (!f.style || !Object.keys(f.style).length)
        return ask(
          s,
          "style",
          "你喜欢怎样旅行？",
          [
            { label: "慢慢逛", data: "我想慢慢逛" },
            { label: "少走路", data: "我想少走路" },
            { label: "避开拥挤", data: "我想避开拥挤" },
            { label: "人文与建筑", data: "我喜欢人文和建筑" },
            { label: "亲近自然", data: "我喜欢自然" },
          ],
          { multi: true, input: "text" },
        );
      if (!f.scope)
        return ask(s, "scope", "这些偏好用于哪次旅行？", [
          { label: "仅这次对话的行程", data: "trip" },
          { label: "长期记住", data: "long_term" },
        ]);
      if (f.scope === "trip") {
        s.style = { ...s.style, ...f.style };
        delete s.flow;
        return displayReply("记在这次对话里了。", { style: s.style });
      }
      const rows = await readMemory(query, ctx.user.id);
      return prepare(
        ctx,
        f.kind,
        {
          style: f.style,
          evidence: f.original,
          versions: Object.fromEntries(
            rows.map((r) => [r.dimension, r.version]),
          ),
        },
        "记住旅行风格",
        Object.entries(f.style).map(
          ([k, v]) => `${styleLabels[k]}：${labelValue(v)}`,
        ),
      );
    }
    if (f.kind === "report") {
      const r = await ctx.api("GET", "/api/me/report");
      delete s.flow;
      return displayReply(
        r.summary ||
          `已完成 ${r.completed || 0} 次旅行，计划中 ${r.planned || 0} 次。`,
        {
          facts: {
            completed: r.completed,
            planned: r.planned,
            cities: r.cities,
            interests: r.interests,
          },
        },
      );
    }
    if (f.kind === "create_trip") return journey(ctx);
    if (f.kind === "create_citywalk") return citywalk(ctx);
    if (["post_comment", "post_reaction"].includes(f.kind)) {
      const posts = await ctx.api("GET", "/api/posts");
      if (!f.postId) {
        if (!posts.length) {
          delete s.flow;
          return displayReply("还没有可选择的帖子。");
        }
        return ask(
          s,
          "postId",
          "选择一个帖子。",
          posts.slice(0, 20).map((p) => ({ label: p.title, data: p.id })),
        );
      }
      const post = posts.find((p) => p.id === f.postId);
      if (!post) throw fail("帖子已不在当前可见列表，请重新选择");
      if (f.kind === "post_comment") {
        if (!f.comment) return textQuestion(s, "comment", "想留下什么评论？");
        z.string().min(1).max(500).parse(f.comment);
        return prepare(
          ctx,
          f.kind,
          { postId: post.id, body: f.comment },
          "发布评论",
          [post.title, f.comment, "其他用户可以看到这条评论"],
        );
      }
      return prepare(
        ctx,
        f.kind,
        { postId: post.id, kind: f.reaction, active: f.active },
        (f.active ? "" : "取消") +
          { like: "点赞", save: "收藏", recommend: "推荐" }[f.reaction],
        [post.title],
      );
    }
    const found = await trip(ctx);
    if (found.reply) return found.reply;
    const t = found.value;
    if (f.kind === "trip_status") {
      if (!f.status)
        return ask(s, "status", "标记为什么状态？", [
          { label: "已完成", data: "completed" },
          { label: "计划中", data: "planned" },
        ]);
      return prepare(
        ctx,
        f.kind,
        { tripId: t.id, version: t.version, status: f.status },
        "更新行程状态",
        [t.title, f.status === "completed" ? "已完成" : "计划中"],
      );
    }
    if (f.kind === "trip_restore") {
      if (!f.restoreVersion) {
        const rows = await ctx.api("GET", `/api/trips/${t.id}/versions`);
        return ask(
          s,
          "restoreVersion",
          "恢复到哪个版本？",
          rows.slice(0, 20).map((r) => ({
            label: `版本 ${r.version} · ${r.reason}`,
            data: r.version,
          })),
        );
      }
      return prepare(
        ctx,
        f.kind,
        { tripId: t.id, version: t.version, restoreVersion: f.restoreVersion },
        "恢复行程版本",
        [t.title, `恢复版本 ${f.restoreVersion}，当前版本 ${t.version}`],
      );
    }
    if (f.kind === "share_trip") {
      return prepare(
        ctx,
        f.kind,
        { tripId: t.id, version: t.version },
        "发布到发现",
        [t.title, "发布当前行程快照，其他用户可以查看"],
      );
    }
    if (f.kind === "edit_trip") {
      const prompt = await needDay(ctx, t);
      if (prompt) return prompt;
      if (!f.edit)
        return textQuestion(
          s,
          "edit",
          `Day ${f.day + 1}：${t.plan.days[f.day].stops.map((p) => p.name).join("、")}。具体怎么改？`,
        );
      const r = await ctx.api("POST", `/api/trips/${t.id}/assistant`, {
        day: f.day,
        text: f.edit,
      });
      if (!r.operation)
        return textQuestion(
          s,
          "edit",
          r.message || "请明确要修改的景点和操作。",
        );
      const op = r.operation;
      if (op.day !== f.day) throw fail("修改日期不一致");
      const stops = t.plan.days[f.day].stops,
        old = stops.find((p) => p.id === op.placeId);
      if (["remove", "replace", "move", "lock"].includes(op.type) && !old)
        throw fail("修改目标不在这一天的行程中");
      // New IDs come from the existing assistant endpoint, never this agent model.
      let next;
      if (op.newPlaceId) {
        const candidates = await ctx.api(
          "GET",
          "/api/places?category=attraction&city=" +
            encodeURIComponent(t.plan.days[f.day].city),
        );
        next = candidates.find((p) => p.id === op.newPlaceId);
        if (!next) throw fail("新景点尚未在候选中核对，请在行程页调整");
      }
      const names = {
        remove: "移除",
        replace: "替换",
        add: "添加",
        move: "调整顺序",
        lock: "锁定",
      };
      return prepare(
        ctx,
        f.kind,
        { tripId: t.id, version: t.version, operation: op },
        "修改行程",
        [
          t.title,
          `Day ${f.day + 1}：${names[op.type] || op.type} ${old?.name || ""}${next ? " → " + next.name : ""}${op.type === "move" ? " → 第 " + (op.to + 1) + " 位" : ""}`,
        ],
      );
    }
    if (f.kind === "recommend_services") return services(ctx, t);
    throw fail("此功能还没有配置自动执行流程");
  }
  async function journey(ctx) {
    const s = ctx.state,
      f = s.flow;
    if (!f.origin) {
      if (!f.originName)
        return cityQuestion(s, "originName", "从哪座城市出发？");
      return findCities(ctx, f.originName, "origin");
    }
    if (!f.cities?.length) {
      if (!f.destinationName)
        return cityQuestion(s, "destinationName", "想去哪座城市？");
      return findCities(ctx, f.destinationName, "city");
    }
    if (!f.citiesDone) {
      if (f.destinationName) return findCities(ctx, f.destinationName, "city");
      return ask(s, "cityNext", "还想增加目的城市吗？", [
        { label: "城市选好了", data: "done" },
        ...(f.cities.length < 5 ? [{ label: "再加一座", data: "more" }] : []),
      ]);
    }
    if (!f.start)
      return textQuestion(s, "start", "哪天出发？请填写完整年月日。", "date");
    if (!f.end) return textQuestion(s, "end", "哪天返回？", "date");
    const ds = datesBetween(f.start, f.end);
    if (ds.length < f.cities.length)
      throw fail("每座城市至少留一天，请调整日期");
    if (!f.sessionId)
      return prepare(
        ctx,
        "create_trip",
        {
          request: {
            origin: {
              label: f.origin.name,
              lat: f.origin.lat,
              lng: f.origin.lng,
            },
            cityIds: f.cities.map((c) => c.id),
            start: f.start,
            end: f.end,
          },
        },
        "开始选择旅行片区",
        [
          `从 ${f.origin.name} 出发`,
          f.cities.map((c) => c.name).join(" → "),
          `${f.start} 至 ${f.end}`,
        ],
        "journey_session",
      );
    const city = f.cities.find((c) => !f.selections?.[c.id]?.length);
    if (city) {
      if (!f.catalog?.[city.id]) {
        const result = await ctx.api(
          "POST",
          `/api/journey/sessions/${f.sessionId}/cities/${encodeURIComponent(city.id)}?async=1`,
          {},
        );
        if (result.status === "loading")
          return ask(s, "retryCity", `${city.name}的片区正在准备。`, [
            { label: "查看片区", data: true },
          ]);
        f.catalog ||= {};
        f.catalog[city.id] = result.clusters.map((g) => ({
          id: g.id,
          name: g.name,
          memberCount: g.memberCount,
          members: g.members.slice(0, 5).map((p) => p.name),
        }));
      }
      const groups = f.catalog[city.id];
      if (!groups.length)
        throw fail("这座城市暂时没有可用片区，请重新选择城市");
      f.selectingCity = city.id;
      return ask(
        s,
        "clusters",
        `想逛${city.name}的哪些片区？`,
        groups.map((g) => ({
          label: `${g.name} · ${g.memberCount} 处 · ${g.members.slice(0, 3).join("、")}`,
          data: g.id,
        })),
        { multi: true },
      );
    }
    if (!f.questions) {
      const r = await ctx.api(
        "POST",
        `/api/journey/sessions/${f.sessionId}/questions`,
        {},
      );
      f.questions = r.questions;
      f.answers = { ...r.defaults, ...f.answers };
    }
    f.answered ||= [];
    const q = f.questions.find(
      (q) =>
        !f.answered.includes(q.id) && !f.explicitAnswerKeys?.includes(q.id),
    );
    if (q) {
      f.answering = q.id;
      return ask(
        s,
        "preference",
        q.title,
        q.options.map((o) =>
          typeof o === "string"
            ? { label: o, data: o }
            : { label: o.label, data: o.value },
        ),
        { multi: q.type === "multi" },
      );
    }
    return prepare(
      ctx,
      "create_trip",
      {
        sessionId: f.sessionId,
        selections: f.selections,
        answers: journeyAnswers.parse(f.answers),
      },
      "生成并保存旅行方案",
      [
        f.cities.map((c) => c.name).join(" → "),
        `${f.start} 至 ${f.end}`,
        ...Object.entries(f.answers).map(
          ([k, v]) => `${styleLabels[k] || k}：${labelValue(v)}`,
        ),
      ],
      "journey_generate",
    );
  }
  async function services(ctx, t) {
    const s = ctx.state,
      f = s.flow,
      prompt = await needDay(ctx, t);
    if (prompt) return prompt;
    if (!f.serviceKind)
      return ask(s, "serviceKind", "想找餐饮还是住宿？", [
        { label: "餐饮", data: "dining" },
        { label: "住宿", data: "stay" },
      ]);
    if (!f.recommendation) {
      const r = await ctx.api(
        "POST",
        `/api/journey/trips/${t.id}/services/recommendations`,
        {
          day: f.day,
          groupMeals: true,
          sort: "distance",
          ...(f.refresh
            ? {
                refresh: true,
                activeSlot: f.refreshSlot,
                excludePlaceIds: f.exclude || [],
              }
            : {}),
        },
      );
      const slot = r.slots.find((sl) => sl.kind === f.serviceKind);
      if (!slot || !slot.items?.length) {
        delete s.flow;
        return displayReply(
          "这一段暂时没有可用推荐。可以在地图上扩大范围再看看。",
          {
            navigation: {
              route: `/services/${t.id}?day=${f.day}`,
              title: "沿途吃住",
            },
          },
        );
      }
      f.recommendation = {
        version: r.version,
        id: slot.recommendationId,
        slot: slot.id,
        items: slot.items.map((p) => ({
          id: p.id,
          name: p.name,
          distanceM: p.distanceMeters,
          lat: p.lat,
          lng: p.lng,
        })),
      };
    }
    const r = f.recommendation;
    if (!f.placeId)
      return ask(s, "servicePlace", "想选哪一家？", [
        ...r.items.map((p) => ({
          label:
            p.name +
            (Number.isFinite(p.distanceM)
              ? ` · ${Math.round(p.distanceM)} 米`
              : ""),
          data: p.id,
        })),
        { label: "换一批", data: "refresh" },
      ]);
    const selection = {
      version: r.version,
      recommendationId: r.id,
      placeId: f.placeId,
    };
    const p = await ctx.api(
      "POST",
      `/api/journey/trips/${t.id}/services/${encodeURIComponent(r.slot)}/preview`,
      selection,
    );
    return prepare(
      ctx,
      "recommend_services",
      { tripId: t.id, slot: r.slot, selection },
      "选入行程",
      [
        t.title,
        `Day ${f.day + 1} · ${p.candidate.name}`,
        f.serviceKind === "stay"
          ? "保存为住宿备选，不产生预订"
          : "保存为餐饮备选，不产生预订",
      ],
    );
  }
  async function citywalk(ctx) {
    const s = ctx.state,
      f = s.flow;
    if (f.walkMode === "edit" && !f.walkId) {
      const rows = await ctx.api("GET", "/api/citywalks?limit=50&offset=0");
      if (!rows.length) {
        delete s.flow;
        return displayReply("还没有保存的 CityWalk，可以先创建一条。");
      }
      return ask(
        s,
        "walkId",
        "编辑哪条 CityWalk？",
        rows.map((w) => ({ label: w.title + " · " + w.city.name, data: w.id })),
      );
    }
    if (f.walkId && !f.previous) {
      const w = await ctx.api("GET", `/api/citywalks/${f.walkId}`);
      f.previous = {
        id: w.id,
        version: w.version,
        city: w.city,
        title: w.title,
      };
      f.walkCity = w.city;
    }
    if (!f.walkCity) {
      if (!f.destinationName)
        return cityQuestion(
          s,
          "destinationName",
          "在哪座城市画一条 CityWalk？",
        );
      return findCities(ctx, f.destinationName, "city");
    }
    if (!f.walkCatalog) {
      const r = await ctx.api(
        "GET",
        `/api/citywalk/catalog/${encodeURIComponent(f.walkCity.id)}`,
      );
      if (r.status === "loading")
        return ask(s, "retryCity", "正在准备这座城市的片区。", [
          { label: "查看片区", data: true },
        ]);
      f.draftId = r.draftId;
      f.walkCatalog = r.clusters.map((g) => ({
        id: g.id,
        name: g.name,
        members: g.members.map((p) => ({
          id: p.id,
          name: p.name,
          lat: p.lat,
          lng: p.lng,
        })),
      }));
    }
    if (!f.walkCatalog.length) throw fail("这座城市暂时没有可用片区");
    if (!f.walkClusters)
      return ask(
        s,
        "walkClusters",
        "选择想逛的片区。",
        f.walkCatalog.map((g) => ({ label: g.name, data: g.id })),
        { multi: true },
      );
    const candidates = [
      ...new Map(
        f.walkCatalog
          .filter((g) => f.walkClusters.includes(g.id))
          .flatMap((g) => g.members)
          .map((p) => [p.id, p]),
      ).values(),
    ];
    if (!f.stopIds)
      return ask(
        s,
        "stopIds",
        "选择至少两个地点。",
        candidates.map((p) => ({ label: p.name, data: p.id })),
        { multi: true },
      );
    if (f.stopIds.length < 2) {
      delete f.stopIds;
      return citywalk(ctx);
    }
    const stops = f.stopIds.map((id) => candidates.find((p) => p.id === id));
    if (stops.some((p) => !p)) throw fail("景点选项已变化，请重新开始");
    if (!f.startId)
      return ask(
        s,
        "startId",
        "从哪个地点开始？",
        stops.map((p) => ({ label: p.name, data: p.id })),
      );
    if (!f.title)
      return ask(
        s,
        "title",
        "给路线起个名字。",
        [
          { label: `${f.walkCity.name}漫步`, data: `${f.walkCity.name}漫步` },
          ...(f.previous?.title
            ? [{ label: f.previous.title, data: f.previous.title }]
            : []),
        ],
        { input: "text" },
      );
    z.string().min(1).max(80).parse(f.title);
    const ordered = orderWalk(stops, f.startId);
    ctx.progress?.("正在核验步行距离…");
    const routePreview = await ctx.api("POST", "/api/citywalk/preview", {
      draftId: f.draftId,
      clusterIds: f.walkClusters,
      stopIds: f.stopIds,
      startId: f.startId,
      ...(f.previous ? { walkId: f.previous.id } : {}),
    });
    if (routePreview.status === "loading")
      return ask(s, "retryWalkRoute", "步行路线正在核验。", [
        { label: "查看路线", data: true },
      ]);
    if (
      routePreview.route?.status !== "verified" ||
      !Number.isFinite(routePreview.route.distanceM) ||
      routePreview.route.distanceM < 0
    )
      return ask(
        s,
        "retryWalkRoute",
        "暂时只能预览，步行距离核验后才能保存。",
        [{ label: "重新核验", data: true }],
      );
    if (routePreview.route.blocked || routePreview.route.distanceM >= 15000) {
      delete f.stopIds;
      delete f.startId;
      return {
        ...(await citywalk(ctx)),
        text: "路线达到 15 公里，请减少地点后重新核验。",
      };
    }
    return prepare(
      ctx,
      f.kind,
      {
        updating: !!f.previous,
        id: f.previous?.id || randomUUID(),
        draftId: f.draftId,
        title: f.title,
        clusterIds: f.walkClusters,
        stopIds: f.stopIds,
        startId: f.startId,
        ...(f.previous ? { version: f.previous.version } : {}),
      },
      f.previous ? "更新 CityWalk" : "保存 CityWalk",
      [
        f.title,
        ordered.map((p) => p.name).join(" → "),
        `实际步行 ${(routePreview.route.distanceM / 1000).toFixed(2)} 公里${routePreview.route.warning ? "，超过 10 公里建议分段走" : ""}`,
      ],
    );
  }
  function applyAnswer(s, key, value, text) {
    const f = s.flow;
    if (key === "origin") {
      if (typeof value === "string") {
        f.originName = value;
        return;
      }
      f.origin = value;
    } else if (key === "city") {
      if (typeof value === "string") {
        f.destinationName = value;
        return;
      }
      if (f.kind === "create_citywalk") {
        f.walkCity = value;
        delete f.destinationName;
        return;
      }
      f.cities ||= [];
      if (f.cities.some((c) => c.id === value.id))
        throw fail("这座城市已经选过了");
      if (f.cities.length >= 5) throw fail("最多选择五座城市");
      f.cities.push(value);
      delete f.destinationName;
    } else if (key === "cityNext") {
      if (value === "done") f.citiesDone = true;
      else delete f.destinationName;
    } else if (key === "clusters") {
      f.selections ||= {};
      f.selections[f.selectingCity] = value;
    } else if (key === "preference") {
      f.answers[f.answering] = value;
      f.answered.push(f.answering);
    } else if (key === "retryCity") {
    } else if (key === "servicePlace") {
      if (value === "refresh") {
        f.exclude = f.recommendation.items.map((p) => p.id);
        f.refreshSlot = f.recommendation.slot;
        f.refresh = true;
        delete f.recommendation;
        delete f.placeId;
      } else f.placeId = value;
    } else if (key === "style") {
      const evidence = Array.isArray(value) ? value.join("，") : value;
      f.style = explicitStyle(evidence);
      f.original = text || evidence;
    } else if (key === "stylePriority") {
      f.answers ||= {};
      f.answers[f.styleConflict] = value;
      f.explicitAnswerKeys = [
        ...new Set([...(f.explicitAnswerKeys || []), f.styleConflict]),
      ];
      delete f.styleConflict;
    } else if (key === "duration") {
      const days = Number(value);
      if (!Number.isInteger(days) || days < 1 || days > 30)
        throw fail("请选择 1 至 30 天");
      f.durationDays = days;
      if (f.start)
        f.end = travelTiming("玩" + days + "天", {
          start: f.start,
          now: now(),
        }).end;
    } else if (["start", "end"].includes(key)) {
      const d = parseDates(value);
      if (d.length !== 1) throw fail("请填写完整日期，例如 2026-10-20");
      f[key] = d[0];
      if (key === "start" && f.durationDays)
        f.end = travelTiming("玩" + f.durationDays + "天", {
          start: f.start,
          now: now(),
        }).end;
    } else f[key] = value;
  }
  async function message(ctx, input) {
    ctx = guardWorkflow(ctx);
    ctx.progress?.("正在识别需求…");
    const text = input.text?.trim() || "",
      s = ctx.state;
    const rule = await classify(text, { enabled: false });
    if (rule.blocked)
      return {
        text:
          bypassConfirmation(text) && s.pendingAction
            ? "请先核对操作卡，再点击“确认执行”。我不会跳过确认。"
            : "这项操作不在授权范围内。我可以帮你使用海迹里的旅行功能。",
        intent: "other",
        ...(s.question ? { question: publicState(s).question } : {}),
      };
    if (rule.intent === "cancel") {
      await query(
        "UPDATE agent_actions SET status='cancelled',finished_at=now() WHERE conversation_id=$1 AND user_id=$2 AND status='pending'",
        [ctx.c.id, ctx.user.id],
      );
      delete s.flow;
      delete s.question;
      delete s.pendingAction;
      delete s.switchRequest;
      return displayReply("已取消待执行操作。");
    }
    if (s.question) {
      const q = s.question;
      if (input.questionId && input.questionId !== q.id)
        throw fail("问题已更新，请使用当前选项", 409);
      if (!input.optionIds?.length && rule.intent === "software_question")
        return {
          ...(await softwareAnswer(ctx, text)),
          question: publicState(s).question,
        };
      if (!input.optionIds?.length && text && s.flow?.kind !== "switch_task") {
        const collected = await collectTravel(ctx, text, q.key);
        if (collected) return collected;
        if (
          rule.intent === "operate" &&
          rule.capability !== s.flow?.kind &&
          rule.capability !== "memory"
        )
          return switchTask(s, text);
        if (!["clarify", "software_help"].includes(s.flow?.kind)) {
          ctx.progress?.("正在理解你的回答…");
          const understood = await understandAnswer(text, q, {
            model,
            enabled: modelEnabled(),
          });
          if (understood.kind === "software_question")
            return {
              ...(await softwareAnswer(ctx, text)),
              question: publicState(s).question,
            };
          if (understood.kind === "change_task") return switchTask(s, text);
          if (understood.kind === "other")
            return {
              text: "我主要帮你安排海迹里的旅行。我们也可以继续当前这一步。",
              intent: "other",
              question: publicState(s).question,
            };
          if (understood.kind === "unclear")
            return displayReply("这一步还没确定，请选一项，或换个说法。", {
              question: publicState(s).question,
            });
          if (understood.optionIds)
            input = {
              ...input,
              questionId: q.id,
              optionIds: understood.optionIds,
            };
          else if (understood.value !== undefined)
            input = { ...input, answerValue: understood.value };
        }
      }
      let value;
      if (input.optionIds?.length) {
        if (!input.questionId) throw fail("缺少当前问题编号");
        const picked = input.optionIds.map((id) =>
          q.options.find((o) => o.id === id),
        );
        if (
          picked.some((o) => !o) ||
          new Set(input.optionIds).size !== picked.length ||
          (!q.multi && picked.length !== 1)
        )
          throw fail("请选择当前问题提供的选项");
        value = q.multi ? picked.map((o) => o.data) : picked[0].data;
      } else if (q.options.length) {
        const exact = q.options.filter((o) => o.label === text);
        const ordinal = text.match(/^第([1-9]\d?)个$/);
        const matched = exact.length
          ? exact
          : ordinal
            ? q.options.slice(Number(ordinal[1]) - 1, Number(ordinal[1]))
            : text.length >= 2 &&
                !q.multi &&
                !["clarify", "software_help"].includes(s.flow?.kind)
              ? q.options.filter((o) => o.label.includes(text))
              : [];
        if (matched.length === 1)
          value = q.multi ? [matched[0].data] : matched[0].data;
        else if (s.flow?.kind === "clarify") {
          delete s.flow;
          delete s.question;
          // A clarification input is a new request, never a capability ID.
          return message(ctx, { text });
        } else if (
          q.input &&
          [
            "originName",
            "destinationName",
            "origin",
            "city",
            "style",
            "title",
            "knowledgeTopic",
          ].includes(q.key)
        )
          value = text;
        else if (rule.intent === "software_question")
          return {
            ...(await knowledge.answer(text)),
            question: publicState(s).question,
          };
        else
          return displayReply("请点选下面的选项，或发送“取消”重新开始。", {
            question: publicState(s).question,
          });
      } else value = input.answerValue ?? text;
      if (!input.optionIds?.length && input.answerValue !== undefined)
        value = input.answerValue;
      if (value === "" || value === undefined) throw fail("请先回答这个问题");
      delete s.question;
      if (q.key === "switchDecision") {
        const pending = s.switchRequest;
        delete s.switchRequest;
        if (value === "stay") {
          s.flow = pending.flow;
          s.question = pending.question;
          return displayReply("继续刚才这一步。", {
            question: publicState(s).question,
          });
        }
        delete s.flow;
        return message(ctx, { text: pending.text });
      }
      applyAnswer(s, q.key, value, text);
      return advance(ctx);
    }
    if (input.optionIds?.length) throw fail("当前没有待回答的选择题", 409);
    if (s.pendingAction) {
      if (/^(确认|执行|好的|可以|好|确定)[。！! ]*$/.test(text))
        return displayReply("请使用操作卡上的“确认执行”，以确认具体内容。");
      await query(
        "UPDATE agent_actions SET status='cancelled',finished_at=now() WHERE id=$1 AND user_id=$2 AND status='pending'",
        [s.pendingAction, ctx.user.id],
      );
      delete s.pendingAction;
      delete s.flow;
    }
    const result = await classify(text, {
      model,
      search: knowledge.search,
      enabled: modelEnabled(),
    });
    if (result.intent === "operate" && result.source === "model") {
      s.flow = {
        kind: "clarify",
        original: text,
        intentMode: "operate",
        suggested: result.capability,
      };
      return advance(ctx);
    }
    if (result.intent === "operate")
      return {
        ...(await start(ctx, result, text)),
        classification: {
          intent: result.intent,
          capability: result.capability,
          source: result.source,
          confidence: result.confidence,
        },
      };
    if (result.intent === "software_question") {
      return softwareAnswer(ctx, text);
    }
    if (result.intent === "clarify") {
      s.flow = { kind: "clarify", original: text };
      return advance(ctx);
    }
    let response = "可以简单聊聊。我主要帮你安排海迹里的旅行。";
    ctx.progress?.("正在简短回复…");
    if (modelEnabled())
      try {
        const r = await model(
          '你是海迹软件助手。对场外问题只给一句极其简短的通用建议，最多60字。不能执行场外任务、写代码、给操作命令、提供链接或编造实时信息。不得声称已操作软件。只返回 {"reply":"文本"}。',
          { text },
          { maxTokens: 120 },
        );
        if (
          typeof r.reply === "string" &&
          r.reply.length <= 60 &&
          !/(已(?:经)?(?:保存|删除|修改|预订|付款)|https?:|执行成功|```|sudo|curl |rm -)/.test(
            r.reply,
          )
        )
          response = r.reply;
      } catch {
        response = "我在。可以先帮你找页面、了解功能，或聊聊想怎样旅行。";
      }
    return { text: response, intent: "other" };
  }
  async function execute(ctx, action, decision) {
    if (
      !workflows[action.capability] ||
      ctx.state.flow?.kind !== action.capability
    )
      throw fail("待确认操作与当前流程不一致", 409);
    ctx = guardWorkflow(ctx, action);
    ctx.progress?.(
      decision === "confirm" ? "正在检查操作范围…" : "正在取消操作…",
    );
    const { state: s } = ctx;
    if (action.replayed) return action.result;
    delete s.pendingAction;
    delete s.question;
    if (decision === "cancel") {
      delete s.flow;
      return { state: s, reply: displayReply("已取消，没有执行这项操作。") };
    }
    const p = action.payload;
    let data, reply;
    switch (action.capability) {
      case "create_trip":
        if (p.after === "journey_session") {
          data = await ctx.api("POST", "/api/journey/sessions", p.request);
          s.flow.sessionId = data.id;
          s.flow.cities = data.cities;
          // The saved session is the committed effect. Loading candidates is a separate turn.
          reply = ask(s, "retryCity", "旅行信息已存好，接着选片区。", [
            { label: "选择片区", data: true },
          ]);
          break;
        }
        if (p.after !== "journey_generate") throw fail("无效的行程操作");
        data = await ctx.api(
          "POST",
          `/api/journey/sessions/${p.sessionId}/generate`,
          { selections: p.selections, answers: p.answers },
        );
        reply = displayReply("旅行方案已保存。", {
          navigation: { route: `/history/${data.id}`, title: data.title },
          tripId: data.id,
        });
        delete s.flow;
        break;
      case "edit_trip":
      case "trip_status":
      case "trip_restore":
        data = await ctx.api("PATCH", `/api/trips/${p.tripId}`, {
          version: p.version,
          ...(p.operation
            ? { operation: p.operation }
            : p.restoreVersion
              ? { restoreVersion: p.restoreVersion }
              : { status: p.status }),
        });
        reply = displayReply("行程已更新。", {
          navigation: { route: `/history/${data.id}`, title: data.title },
          tripId: data.id,
        });
        delete s.flow;
        break;
      case "recommend_services":
        data = await ctx.api(
          "PUT",
          `/api/journey/trips/${p.tripId}/services/${encodeURIComponent(p.slot)}`,
          p.selection,
        );
        reply = displayReply("已保存到行程。", {
          navigation: { route: `/history/${p.tripId}`, title: "查看行程" },
          tripId: p.tripId,
        });
        delete s.flow;
        break;
      case "profile_update":
        await ctx.api("PATCH", "/api/me", { nickname: p.nickname });
        reply = displayReply("昵称已更新。", {
          navigation: { route: "/account", title: "我的账号" },
        });
        delete s.flow;
        break;
      case "create_citywalk": {
        const { updating, after, ...body } = p;
        data = await ctx.api(
          updating ? "PUT" : "POST",
          updating ? `/api/citywalks/${p.id}` : "/api/citywalks",
          body,
        );
        reply = displayReply("CityWalk 已保存。", {
          navigation: { route: `/citywalk/${data.id}`, title: data.title },
        });
        delete s.flow;
        break;
      }
      case "post_reaction":
        await ctx.api("POST", `/api/posts/${p.postId}/reactions`, {
          kind: p.kind,
          active: p.active,
        });
        reply = displayReply("帖子互动已更新。");
        delete s.flow;
        break;
      case "post_comment":
        await ctx.api("POST", `/api/posts/${p.postId}/comments`, {
          body: p.body,
        });
        reply = displayReply("评论已发布。");
        delete s.flow;
        break;
      case "share_trip": {
        const current = await ctx.api("GET", `/api/trips/${p.tripId}`);
        if (current.version !== p.version)
          throw fail("行程已改变，请重新预览后发布", 409);
        await ctx.api("POST", "/api/discovery/publish", {
          kind: "journey",
          id: p.tripId,
        });
        reply = displayReply("行程帖子已发布。");
        delete s.flow;
        break;
      }
      case "clear_history":
        await ctx.api("DELETE", "/api/me/history", {});
        reply = displayReply("浏览历史已清空。");
        delete s.flow;
        break;
      case "memory":
        await saveMemory(
          transaction,
          ctx.user.id,
          p.style,
          p.evidence,
          p.versions,
        );
        reply = displayReply("旅行风格已记住，以后的推荐会参考它。");
        delete s.flow;
        break;
      case "forget_memory":
        await transaction(async (db) => {
          await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            ctx.user.id,
          ]);
          const rows = (
            await db.query(
              "SELECT dimension,version FROM user_travel_memory WHERE user_id=$1",
              [ctx.user.id],
            )
          ).rows;
          if (
            rows.length !== Object.keys(p.versions).length ||
            rows.some((r) => p.versions[r.dimension] !== r.version)
          )
            throw fail("记忆已更新，请重新确认", 409);
          await db.query("DELETE FROM user_travel_memory WHERE user_id=$1", [
            ctx.user.id,
          ]);
        });
        reply = displayReply("长期旅行风格记忆已清除。");
        delete s.flow;
        break;
      default:
        throw fail("此操作不允许自动执行", 403);
    }
    return { state: s, reply };
  }
  return { message, execute, advance };
}
