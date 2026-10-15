import { isDeepStrictEqual } from "node:util";
import { fail } from "./store.mjs";

// These are application workflows, never model-provided tools or URLs.
export const workflows = {
  navigate: ["确定页面", "打开页面"],
  create_trip: [
    "确认城市和日期",
    "创建旅行草稿",
    "选择片区和偏好",
    "确认生成",
    "保存行程",
  ],
  edit_trip: ["读取本人行程", "确认日期和修改", "预览变更", "确认保存"],
  trip_status: ["读取本人行程", "选择状态", "确认保存"],
  trip_restore: ["读取本人行程", "选择历史版本", "确认恢复"],
  recommend_services: [
    "读取本人行程",
    "选择日期和类别",
    "查询推荐",
    "预览商家",
    "确认保存",
  ],
  create_citywalk: ["选择城市和片区", "选择景点和起点", "预览路线", "确认保存"],
  share_trip: ["读取本人行程", "预览发布", "确认发布"],
  post_reaction: ["选择可见帖子", "预览互动", "确认执行"],
  post_comment: ["选择可见帖子", "填写评论", "确认发布"],
  profile_update: ["确认昵称", "预览资料", "确认保存"],
  account_secure: ["打开账号页面"],
  report: ["读取本人报告"],
  memory: ["选择旅行风格", "确认记忆范围", "确认保存"],
  forget_memory: ["读取本人记忆", "确认清除"],
  clear_history: ["预览清除范围", "确认清空"],
};

const equal = (a, b) => isDeepStrictEqual(a, b);
export function workflowAllows({ state, action }, method, path, body) {
  const f = state.flow || {},
    p = action?.payload || {};
  if (!workflows[f.kind] || (action && action.capability !== f.kind))
    return false;
  const call = (m, url, expected) =>
    method === m &&
    path === url &&
    (expected === undefined || equal(body, expected));
  if (action) {
    switch (f.kind) {
      case "create_trip":
        return p.after === "journey_session"
          ? !f.sessionId && call("POST", "/api/journey/sessions", p.request)
          : p.after === "journey_generate" &&
              p.sessionId === f.sessionId &&
              call("POST", `/api/journey/sessions/${f.sessionId}/generate`, {
                selections: p.selections,
                answers: p.answers,
              });
      case "edit_trip":
      case "trip_status":
      case "trip_restore":
        return (
          p.tripId === f.tripId &&
          call("PATCH", `/api/trips/${p.tripId}`, {
            version: p.version,
            ...(p.operation
              ? { operation: p.operation }
              : p.restoreVersion
                ? { restoreVersion: p.restoreVersion }
                : { status: p.status }),
          })
        );
      case "recommend_services":
        return (
          p.tripId === f.tripId &&
          p.slot === f.recommendation?.slot &&
          call(
            "PUT",
            `/api/journey/trips/${p.tripId}/services/${encodeURIComponent(p.slot)}`,
            p.selection,
          )
        );
      case "share_trip":
        return (
          p.tripId === f.tripId &&
          (call("GET", `/api/trips/${p.tripId}`) ||
            call("POST", "/api/discovery/publish", {
              kind: "journey",
              id: p.tripId,
            }))
        );
      case "profile_update":
        return call("PATCH", "/api/me", { nickname: p.nickname });
      case "clear_history":
        return call("DELETE", "/api/me/history", {});
      case "create_citywalk": {
        const { updating, after, ...data } = p;
        return (
          (!updating || p.id === f.walkId) &&
          call(
            updating ? "PUT" : "POST",
            updating ? `/api/citywalks/${p.id}` : "/api/citywalks",
            data,
          )
        );
      }
      case "post_comment":
        return (
          p.postId === f.postId &&
          call("POST", `/api/posts/${p.postId}/comments`, { body: p.body })
        );
      case "post_reaction":
        return (
          p.postId === f.postId &&
          call("POST", `/api/posts/${p.postId}/reactions`, {
            kind: p.kind,
            active: p.active,
          })
        );
      default:
        return false;
    }
  }
  if (
    [
      "edit_trip",
      "trip_status",
      "trip_restore",
      "recommend_services",
      "share_trip",
    ].includes(f.kind)
  ) {
    if (!f.tripId && call("GET", "/api/trips?summary=1&limit=20&offset=0"))
      return true;
    if (f.tripId && call("GET", `/api/trips/${f.tripId}`)) return true;
  }
  const places = method === "GET" && path.startsWith("/api/places?");
  if (places) {
    const q = new URLSearchParams(path.split("?")[1]);
    if (["create_trip", "create_citywalk"].includes(f.kind))
      return (
        [...q.keys()].every((k) => ["category", "q"].includes(k)) &&
        q.get("category") === "city" &&
        !!q.get("q")
      );
    return (
      f.kind === "edit_trip" &&
      !!f.tripId &&
      q.get("category") === "attraction" &&
      !!q.get("city") &&
      [...q.keys()].every((k) => ["category", "city"].includes(k))
    );
  }
  switch (f.kind) {
    case "create_trip":
      if (!f.sessionId) return false;
      if (
        f.cities?.some(
          (c) =>
            !f.selections?.[c.id]?.length &&
            call(
              "POST",
              `/api/journey/sessions/${f.sessionId}/cities/${encodeURIComponent(c.id)}?async=1`,
              {},
            ),
        )
      )
        return true;
      return (
        f.cities?.every((c) => f.selections?.[c.id]?.length) &&
        call("POST", `/api/journey/sessions/${f.sessionId}/questions`, {})
      );
    case "edit_trip":
      return (
        !!f.tripId &&
        Number.isInteger(f.day) &&
        !!f.edit &&
        call("POST", `/api/trips/${f.tripId}/assistant`, {
          day: f.day,
          text: f.edit,
        })
      );
    case "trip_restore":
      return !!f.tripId && call("GET", `/api/trips/${f.tripId}/versions`);
    case "recommend_services": {
      if (!f.tripId || !Number.isInteger(f.day) || !f.serviceKind) return false;
      if (
        call("POST", `/api/journey/trips/${f.tripId}/services/recommendations`)
      )
        return equal(body, {
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
        });
      const r = f.recommendation;
      return (
        !!r?.items.some((i) => i.id === f.placeId) &&
        call(
          "POST",
          `/api/journey/trips/${f.tripId}/services/${encodeURIComponent(r.slot)}/preview`,
          { version: r.version, recommendationId: r.id, placeId: f.placeId },
        )
      );
    }
    case "create_citywalk":
      return (
        (!f.walkId && call("GET", "/api/citywalks?limit=50&offset=0")) ||
        (!!f.walkId && call("GET", `/api/citywalks/${f.walkId}`)) ||
        (!!f.walkCity &&
          call(
            "GET",
            `/api/citywalk/catalog/${encodeURIComponent(f.walkCity.id)}`,
          ))
      );
    case "post_comment":
    case "post_reaction":
      return call("GET", "/api/posts");
    case "report":
      return call("GET", "/api/me/report");
    default:
      return false;
  }
}

export function guardWorkflow(ctx, action) {
  const original = ctx.workflowApi || ctx.api;
  let executed = 0;
  return {
    ...ctx,
    workflowApi: original,
    api: async (method, path, body) => {
      if (!workflowAllows({ state: ctx.state, action }, method, path, body))
        throw fail("这一步超出了当前操作范围，请重新选择功能", 403);
      if (
        action &&
        (action.capability === "share_trip"
          ? executed === 0
            ? method !== "GET"
            : executed === 1
              ? method !== "POST"
              : true
          : executed > 0)
      )
        throw fail("接口调用顺序与当前流程不一致", 403);
      ctx.progress?.(
        path === "/api/discovery/publish"
          ? "正在发布到发现…"
          : method === "PATCH" && path.startsWith("/api/trips/")
            ? "正在编辑行程…"
            : method === "GET" && path.startsWith("/api/trips")
              ? "正在读取本人行程…"
              : path.endsWith("/recommendations")
                ? "正在寻找附近吃住…"
                : path.endsWith("/generate")
                  ? "正在生成旅行方案…"
                  : action
                    ? "正在保存已确认的内容…"
                    : "正在核对权限与候选…",
      );
      // The normal endpoint still checks session, ownership, candidate membership and versions.
      const result = await original(method, path, body);
      executed++;
      ctx.progress?.("正在整理结果…");
      return result;
    },
  };
}
