/* 将 AI 操作映射到允许调用的业务接口。 */

import { fail } from "./store.mjs";

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
    /^\/api\/discovery\/publish$/,
    /^\/api\/journey\/sessions$/,
    /^\/api\/journey\/sessions\/[\da-f-]{36}\/(?:cities\/[^/?#]+(?:\?async=1)?|questions|generate)$/,
    /^\/api\/journey\/trips\/[\da-f-]{36}\/services\/recommendations$/,
    /^\/api\/journey\/trips\/[\da-f-]{36}\/services\/[^/?#]+\/preview$/,
    /^\/api\/trips\/[\da-f-]{36}\/assistant$/,
    /^\/api\/posts$/,
    /^\/api\/posts\/[\da-f-]{36}\/(?:reactions|comments)$/,
    /^\/api\/citywalks$/,
    /^\/api\/citywalk\/preview$/,
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
  turnId=null,
  actionId=null,
  parentRequestId=null,
  fetchImpl = fetch,
}) {
  return async function call(method, path, body) {
    if (!allowedCall(method, path)) throw fail("此操作没有注册到智能体", 403);
    if (!/^[a-f0-9]{64}$/.test(session || "")) throw fail("请重新登录", 401);
    const p = Number(typeof port === "function" ? port() : port);
    if (!Number.isInteger(p) || p < 1 || p > 65535)
      throw fail("服务尚未就绪", 503);
    const audit = (
      await query(
        "INSERT INTO agent_tool_calls(conversation_id,user_id,method,path,turn_id,action_id,parent_request_id,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id",
        [conversationId, userId, method, path.split('?')[0],turnId,actionId,parentRequestId],
      )
    ).rows[0].id;
    let r;const started=performance.now();
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
      await query("UPDATE agent_tool_calls SET outcome='network_error',finished_at=now(),duration_ms=$2 WHERE id=$1",[audit,Math.min(2147483647,Math.round(performance.now()-started))]);
      throw fail("服务暂时未返回结果；请刷新核对，避免重复操作", 503);
    }
    const requestId=r.headers?.get('x-request-id');
    await query("UPDATE agent_tool_calls SET status=$2,outcome=$3,finished_at=now(),duration_ms=$4,request_id=$5 WHERE id=$1", [
      audit,
      r.status,
      r.ok?'http_success':'http_error',
      Math.min(2147483647,Math.round(performance.now()-started)),
      /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(requestId||'')?requestId:null,
    ]);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw fail(data.error || "业务操作暂不可用", r.status);
    return data;
  };
}
