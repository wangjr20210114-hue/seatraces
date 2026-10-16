import { z } from "zod";
import { requireManagement } from "./permissions.mjs";
import { alertRules, createHealthMonitor } from "./health-monitor.mjs";
import { createMaintenanceWorker } from "./maintenance-worker.mjs";
const fail = (message, status = 400) =>
  Object.assign(Error(message), { status });
const paging = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
});
export function installMaintenance(
  app,
  {
    query,
    transaction,
    events,
    runtime,
    extraExecutors = {},
    autoStart = false,
  },
) {
  const monitor = createHealthMonitor({
    query,
    transaction,
    events,
    ...(runtime ? { runtime } : {}),
  });
  const executors = {
    health_check: async ({ checkpoint }) => {
      await checkpoint({ step: "checking_health" });
      return monitor.sample();
    },
    ...extraExecutors,
  };
  const worker = createMaintenanceWorker({ query, transaction, executors });
  const audit = (req, action, id, metadata = {}, c) =>
    events.append(
      {
        userId: req.user.id,
        kind: "admin",
        action,
        resourceId: id,
        requestId: req.operationRequestId,
        metadata,
      },
      c,
    );
  app.get(
    "/api/admin/maintenance/tasks",
    requireManagement,
    async (req, res) => {
      const { limit, offset } = paging.parse(req.query),
        state = z
          .enum([
            "all",
            "queued",
            "running",
            "completed",
            "failed",
            "interrupted",
            "cancelled",
          ])
          .default("all")
          .parse(req.query.state);
      const items = (
        await query(
          `SELECT t.id,t.kind,t.state,t.retry_of,t.progress,t.error_code,t.cancel_requested,t.version,
      t.created_at,t.started_at,t.finished_at,u.username requested_by FROM maintenance_tasks t LEFT JOIN users u ON u.id=t.requested_by
      WHERE $1='all' OR t.state=$1 ORDER BY t.created_at DESC,t.id LIMIT $2 OFFSET $3`,
          [state, limit + 1, offset],
        )
      ).rows;
      res.json({
        items: items.slice(0, limit),
        hasMore: items.length > limit,
        kinds: Object.keys(executors),
      });
    },
  );
  app.get(
    "/api/admin/maintenance/tasks/:id",
    requireManagement,
    async (req, res) => {
      const id = z.uuid().parse(req.params.id),
        r = (
          await query(
            `SELECT id,kind,state,retry_of,progress,result,error_code,cancel_requested,version,
      created_at,started_at,finished_at FROM maintenance_tasks WHERE id=$1`,
            [id],
          )
        ).rows[0];
      if (!r) throw fail("任务不存在", 404);
      res.json(r);
    },
  );
  app.post(
    "/api/admin/maintenance/tasks",
    requireManagement,
    async (req, res) => {
      const b = z
        .object({
          id: z.uuid(),
          kind: z.enum(["health_check"]),
          confirmation: z.literal("run-task"),
        })
        .strict()
        .parse(req.body);
      const result = await transaction(async (c) => {
        await c.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('seatraces.maintenance-create',0))",
        );
        const old = (
          await c.query(
            "SELECT id,kind,requested_by FROM maintenance_tasks WHERE id=$1",
            [b.id],
          )
        ).rows[0];
        if (old) {
          if (old.kind !== b.kind || old.requested_by !== req.user.id)
            throw fail("任务编号已使用", 409);
          return { id: old.id };
        }
        const active = (
          await c.query(
            "SELECT id FROM maintenance_tasks WHERE kind=$1 AND state IN ('queued','running') LIMIT 1",
            [b.kind],
          )
        ).rows[0];
        if (active) throw fail("已有同类任务等待或正在运行", 409);
        await c.query(
          "INSERT INTO maintenance_tasks(id,kind,requested_by) VALUES($1,$2,$3)",
          [b.id, b.kind, req.user.id],
        );
        await audit(req, "task.queued", b.id, { kind: b.kind }, c);
        return { id: b.id };
      });
      res.status(202).json(result);
    },
  );
  app.post(
    "/api/admin/maintenance/tasks/:id/cancel",
    requireManagement,
    async (req, res) => {
      const id = z.uuid().parse(req.params.id),
        b = z
          .object({
            version: z.number().int().positive(),
            confirmation: z.literal("cancel-task"),
          })
          .strict()
          .parse(req.body);
      const result = await transaction(async (c) => {
        const r = (
          await c.query(
            "SELECT * FROM maintenance_tasks WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!r) throw fail("任务不存在", 404);
        if (r.version !== b.version || !["queued", "running"].includes(r.state))
          throw fail("任务状态已变化，请刷新", 409);
        const row = (
          await c.query(
            `UPDATE maintenance_tasks SET cancel_requested=true,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,
        finished_at=CASE WHEN state='queued' THEN now() ELSE finished_at END,version=version+1 WHERE id=$1 RETURNING id,state,cancel_requested,version`,
            [id],
          )
        ).rows[0];
        await audit(req, "task.cancel_requested", id, {}, c);
        return row;
      });
      res.json(result);
    },
  );
  app.post(
    "/api/admin/maintenance/tasks/:id/retry",
    requireManagement,
    async (req, res) => {
      const id = z.uuid().parse(req.params.id),
        b = z
          .object({
            id: z.uuid(),
            version: z.number().int().positive(),
            confirmation: z.literal("retry-task"),
          })
          .strict()
          .parse(req.body);
      const result = await transaction(async (c) => {
        await c.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('seatraces.maintenance-create',0))",
        );
        const r = (
          await c.query(
            "SELECT * FROM maintenance_tasks WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (!r) throw fail("任务不存在", 404);
        if (r.kind === 'log_export') throw fail('请在操作日志中按当前条件重新创建导出',409);
        const old = (
          await c.query("SELECT id FROM maintenance_tasks WHERE retry_of=$1", [
            id,
          ])
        ).rows[0];
        if (old) return old;
        if (
          r.version !== b.version ||
          !["failed", "interrupted", "cancelled"].includes(r.state)
        )
          throw fail("此任务不可重试", 409);
        if (!Object.hasOwn(executors, r.kind))
          throw fail("任务类型当前不可用", 409);
        if (
          (
            await c.query(
              "SELECT 1 FROM maintenance_tasks WHERE kind=$1 AND state IN ('queued','running')",
              [r.kind],
            )
          ).rowCount
        )
          throw fail("已有同类任务运行中", 409);
        if (
          (await c.query("SELECT 1 FROM maintenance_tasks WHERE id=$1", [b.id]))
            .rowCount
        )
          throw fail("任务编号已使用", 409);
        await c.query(
          "INSERT INTO maintenance_tasks(id,kind,requested_by,retry_of,parameters) VALUES($1,$2,$3,$4,$5)",
          [b.id, r.kind, req.user.id, id, r.parameters],
        );
        await audit(req, "task.retry", b.id, { retryOf: id, kind: r.kind }, c);
        return { id: b.id };
      });
      res.status(202).json(result);
    },
  );
  app.get(
    "/api/admin/maintenance/health",
    requireManagement,
    async (req, res) => {
      const samples = (
        await query(
          "SELECT sampled_at,data FROM operational_samples WHERE sampled_at>now()-interval '1 hour' ORDER BY sampled_at DESC LIMIT 60",
        )
      ).rows;
      res.json({
        samples,
        rules: alertRules,
        samplingSeconds: 60,
        requestCoverage: "仅已登录用户的已记录接口；不包含游客请求或未落库日志",
        lastSampleAt: samples[0]?.sampled_at || null,
      });
    },
  );
  app.get(
    "/api/admin/maintenance/alerts",
    requireManagement,
    async (req, res) => {
      const { limit, offset } = paging.parse(req.query),
        state = z
          .enum(["all", "active", "resolved"])
          .default("active")
          .parse(req.query.state);
      const rows = (
        await query(
          `SELECT id,rule,level,state,observed,opened_at,last_seen_at,acknowledged_at,resolved_at,version
      FROM operational_alerts WHERE $1='all' OR ($1='active' AND state<>'resolved') OR ($1='resolved' AND state='resolved')
      ORDER BY last_seen_at DESC,id LIMIT $2 OFFSET $3`,
          [state, limit + 1, offset],
        )
      ).rows;
      res.json({
        items: rows.slice(0, limit),
        hasMore: rows.length > limit,
        rules: alertRules,
      });
    },
  );
  app.post(
    "/api/admin/maintenance/alerts/:id/acknowledge",
    requireManagement,
    async (req, res) => {
      const id = z.uuid().parse(req.params.id),
        b = z
          .object({
            version: z.number().int().positive(),
            confirmation: z.literal("acknowledge-alert"),
          })
          .strict()
          .parse(req.body);
      const row = await transaction(async (c) => {
        const r = (
          await c.query(
            `UPDATE operational_alerts SET state='acknowledged',acknowledged_at=now(),acknowledged_by=$3,
        version=version+1 WHERE id=$1 AND version=$2 AND state='open' RETURNING id,state,version`,
            [id, b.version, req.user.id],
          )
        ).rows[0];
        if (!r) throw fail("告警状态已变化，请刷新", 409);
        await audit(req, "alert.acknowledged", id, {}, c);
        return r;
      });
      res.json(row);
    },
  );
  let sampler;
  function start() {
    if (sampler) return;
    worker.start();
    sampler = setInterval(() => void monitor.sample().catch(() => {}), 60000);
    sampler.unref();
    void monitor.sample().catch(() => {});
  }
  if (autoStart) start();
  return {
    worker,
    monitor,
    start,
    async close() {
      clearInterval(sampler);
      await worker.close();
    },
  };
}
