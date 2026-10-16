import { randomUUID } from "node:crypto";
import {requestContext} from '../operations/request-context.mjs';
export const fail = (message, status = 400) =>
  Object.assign(Error(message), { status });
export function createAgentStore({ query, transaction }) {
  const own = async (id, user) => {
    const c = (
      await query(
        "SELECT * FROM agent_conversations WHERE id=$1 AND user_id=$2",
        [id, user],
      )
    ).rows[0];
    if (!c) throw fail("对话不存在", 404);
    return c;
  };
  async function start(user) {
    const id = randomUUID();
    await query("INSERT INTO agent_conversations(id,user_id) VALUES($1,$2)", [
      id,
      user,
    ]);
    return { id, state: {}, revision: 0 };
  }
  async function begin(id, user, requestId, input, revision) {
    return transaction(async (db) => {
      const c = (
        await db.query(
          "SELECT * FROM agent_conversations WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [id, user],
        )
      ).rows[0];
      if (!c) throw fail("对话不存在", 404);
      const old = (
        await db.query(
          "SELECT * FROM agent_turns WHERE conversation_id=$1 AND request_id=$2",
          [id, requestId],
        )
      ).rows[0];
      if (old) {
        if (old.response) return { cached: old.response };
        throw fail("上次请求仍在处理或结果待核对，请刷新对话", 409);
      }
      if (c.revision !== revision) throw fail("对话已更新，请刷新后再试", 409);
      if (c.busy_until && new Date(c.busy_until) > new Date())
        throw fail("正在处理上一条消息，请稍等", 409);
      if (
        (
          await db.query(
            "SELECT count(*)::int n FROM agent_turns WHERE user_id=$1 AND created_at>now()-interval '1 minute'",
            [user],
          )
        ).rows[0].n >= 30
      )
        throw fail("请稍等一下再发送", 429);
      const token = randomUUID();
      await db.query(
        "UPDATE agent_conversations SET busy_until=now()+interval '3 minutes',busy_token=$3 WHERE id=$1 AND user_id=$2",
        [id, user, token],
      );
      await db.query(
        "INSERT INTO agent_turns(id,conversation_id,user_id,request_id,input,status,server_request_id) VALUES($1,$2,$3,$4,$5,'running',$6)",
        [token, id, user, requestId, input,requestContext()?.requestId||null],
      );
      return { conversation: c, token };
    });
  }
  async function finish(c, user, token, state, reply, status = "completed") {
    return transaction(async (db) => {
      const r = await db.query(
        "UPDATE agent_conversations SET state=$3,revision=revision+1,busy_until=NULL,busy_token=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND busy_token=$4 RETURNING revision",
        [c.id, user, JSON.stringify(state), token],
      );
      if (!r.rowCount) throw fail("本次处理已失效，请刷新对话核对结果", 409);
      const response = {
        ...reply,
        conversationId: c.id,
        revision: r.rows[0].revision,
      };
      await db.query(
        "UPDATE agent_turns SET response=$2,status=$3,finished_at=now(),duration_ms=least(2147483647,greatest(0,extract(epoch FROM clock_timestamp()-created_at)*1000))::int WHERE id=$1",
        [token, JSON.stringify(response), status],
      );
      return response;
    });
  }
  async function offer(c, user, capability, payload, preview) {
    const id = randomUUID();
    await query(
      "UPDATE agent_actions SET status='cancelled',finished_at=now() WHERE conversation_id=$1 AND user_id=$2 AND status='pending'",
      [c.id, user],
    );
    await query(
      "INSERT INTO agent_actions(id,conversation_id,user_id,capability,payload,preview,status) VALUES($1,$2,$3,$4,$5,$6,'pending')",
      [
        id,
        c.id,
        user,
        capability,
        JSON.stringify(payload),
        JSON.stringify(preview),
      ],
    );
    return { id, ...preview, status: "pending" };
  }
  async function claim(id, c, user, decision) {
    return transaction(async (db) => {
      const a = (
        await db.query(
          "SELECT * FROM agent_actions WHERE id=$1 AND conversation_id=$2 AND user_id=$3 FOR UPDATE",
          [id, c.id, user],
        )
      ).rows[0];
      if (!a) throw fail("操作不存在", 404);
      if (a.status === "completed") return { ...a, replayed: true };
      if (a.status !== "pending")
        throw fail("该操作已取消、执行过或结果待核对；请刷新查看", 409);
      if (new Date(a.expires_at) <= new Date())
        throw fail("确认已过期，请重新发起操作", 410);
      await db.query("UPDATE agent_actions SET status=$2 WHERE id=$1", [
        id,
        decision === "confirm" ? "executing" : "cancelled",
      ]);
      return a;
    });
  }
  return { own, start, begin, finish, offer, claim };
}
