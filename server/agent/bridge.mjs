import { fail } from "./store.mjs";

// Only code-owned calls. No model-selected URL, HTTP method, credentials or headers.
const patterns = {
  GET: [
    /^\/api\/places\?/,
    /^\/api\/trips(?:\?[^#]*)?$/,
    /^\/api\/trips\/[\da-f-]{36}(?:\/versions)?$/,
    /^\/api\/me\/report$/,
    /^\/api\/citywalks(?:\?[^#]*)?$/,
    /^\/api\/citywalks\/[\da-f-]{36}$/,
    /^\/api\/citywalk\/catalog\/[^/?#]+$/,
    /^\/api\/posts$/,
  ],
  POST: [
    /^\/api\/journey\/sessions$/,
    /^\/api\/journey\/sessions\/[\da-f-]{36}\/(?:cities\/[^/?#]+(?:\?async=1)?|questions|generate)$/,
    /^\/api\/journey\/trips\/[\da-f-]{36}\/services\/recommendations$/,
    /^\/api\/journey\/trips\/[\da-f-]{36}\/services\/[^/?#]+\/preview$/,
    /^\/api\/trips\/[\da-f-]{36}\/assistant$/,
    /^\/api\/posts$/,
    /^\/api\/posts\/[\da-f-]{36}\/(?:reactions|comments)$/,
    /^\/api\/citywalks$/,
  ],
  PATCH: [/^\/api\/trips\/[\da-f-]{36}$/, /^\/api\/me$/],
  PUT: [
    /^\/api\/journey\/trips\/[\da-f-]{36}\/services\/[^/?#]+$/,
    /^\/api\/citywalks\/[\da-f-]{36}$/,
  ],
  DELETE: [/^\/api\/me\/history$/],
};
export function allowedCall(method, path) {
  return (
    typeof path === "string" &&
    path.length < 2000 &&
    !/[\r\n\\]/.test(path) &&
    Boolean(patterns[method]?.some((p) => p.test(path)))
  );
}
export function createApiBridge({
  port,
  session,
  query,
  userId,
  conversationId,
  fetchImpl = fetch,
}) {
  return async function call(method, path, body) {
    if (!allowedCall(method, path)) throw fail("此操作没有注册到智能体", 403);
    if (!/^[a-f0-9]{64}$/.test(session || "")) throw fail("请重新登录", 401);
    const p = Number(typeof port === "function" ? port() : port);
    if (!Number.isInteger(p) || p < 1 || p > 65535)
      throw fail("服务尚未就绪", 503);
    // Local listener is fixed by startup, never by Host / forwarded headers or request text.
    const audit = (
      await query(
        "INSERT INTO agent_tool_calls(conversation_id,user_id,method,path) VALUES($1,$2,$3,$4) RETURNING id",
        [conversationId, userId, method, path],
      )
    ).rows[0].id;
    let r;
    try {
      r = await fetchImpl(`http://127.0.0.1:${p}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(110000),
        headers: {
          "Content-Type": "application/json",
          "X-Seatraces": "1",
          Cookie: `st_session=${session}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw fail("服务暂时未返回结果；请刷新核对，避免重复操作", 503);
    }
    await query("UPDATE agent_tool_calls SET status=$2 WHERE id=$1", [
      audit,
      r.status,
    ]);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw fail(data.error || "业务操作暂不可用", r.status);
    return data;
  };
}
