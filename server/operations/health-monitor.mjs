import v8 from "node:v8";

export const alertRules = {
  api_errors: {
    name: "接口错误率",
    level: "warning",
    description: "近5分钟已记录接口请求至少20次，5xx至少5次且比例不低于10%。",
  },
  heap_pressure: {
    name: "JavaScript 堆内存",
    level: "critical",
    description: "当前已用堆达到 V8 堆上限的85%。",
  },
  log_queue: {
    name: "日志积压",
    level: "warning",
    description: "当前待写普通日志达到1000条。",
  },
  log_loss: {
    name: "日志丢失",
    level: "critical",
    description:
      "自上次成功采样以来出现日志丢弃或写入失败；首次采样检查本进程累计。",
  },
  task_failures: {
    name: "维护任务失败",
    level: "warning",
    description: "近24小时存在失败或中断、且未通过重试成功恢复的维护任务。",
  },
};
export function healthDecisions(data) {
  return {
    api_errors:
      data.requests >= 20 &&
      data.errors >= 5 &&
      data.errors / data.requests >= 0.1,
    heap_pressure:
      data.heapLimitBytes > 0 &&
      data.heapUsedBytes / data.heapLimitBytes >= 0.85,
    log_queue: data.queued >= 1000,
    log_loss: data.newDropped > 0 || data.newFailed > 0,
    task_failures: data.failedTasks > 0,
  };
}

export function createHealthMonitor({
  query,
  transaction,
  events,
  runtime = () => ({
    heapUsedBytes: process.memoryUsage().heapUsed,
    rssBytes: process.memoryUsage().rss,
    heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
    uptimeSeconds: Math.floor(process.uptime()),
  }),
}) {
  let pending,
    previous = { dropped: 0, failed: 0 };
  async function collect() {
    const counts = (
      await query(`SELECT count(*) FILTER(WHERE kind='request')::int requests,
      count(*) FILTER(WHERE kind='request' AND status>=500)::int errors,
      (SELECT count(*)::int FROM maintenance_tasks t WHERE state IN ('failed','interrupted')
        AND finished_at>now()-interval '24 hours' AND NOT EXISTS(
          WITH RECURSIVE retries AS (SELECT id,state FROM maintenance_tasks WHERE retry_of=t.id
            UNION ALL SELECT n.id,n.state FROM maintenance_tasks n JOIN retries r ON n.retry_of=r.id)
          SELECT 1 FROM retries WHERE state='completed')) failed_tasks
      FROM operation_events WHERE created_at>now()-interval '5 minutes'`)
    ).rows[0];
    const stats = events.stats(),
      data = {
        ...runtime(),
        requests: counts.requests,
        errors: counts.errors,
        failedTasks: counts.failed_tasks,
        queued: stats.queued,
        dropped: stats.dropped,
        failed: stats.failed,
        newDropped: Math.max(0, stats.dropped - previous.dropped),
        newFailed: Math.max(0, stats.failed - previous.failed),
      };
    const decisions = healthDecisions(data);
    const result = await transaction(async (c) => {
      // Only one monitor updates active alerts at a time, across server processes.
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('seatraces.health-monitor',0))",
      );
      const sample = (
        await c.query(
          "INSERT INTO operational_samples(data) VALUES($1) RETURNING id,sampled_at",
          [data],
        )
      ).rows[0];
      for (const [rule, active] of Object.entries(decisions)) {
        const values = {
          api_errors: {
            requests: data.requests,
            errors: data.errors,
            windowSeconds: 300,
          },
          heap_pressure: {
            used: data.heapUsedBytes,
            limit: data.heapLimitBytes,
          },
          log_queue: { queued: data.queued },
          log_loss: { dropped: data.newDropped, failed: data.newFailed },
          task_failures: { count: data.failedTasks, windowHours: 24 },
        }[rule];
        if (active)
          await c.query(
            `INSERT INTO operational_alerts(rule,level,state,observed) VALUES($1,$2,'open',$3)
          ON CONFLICT(rule) WHERE state<>'resolved' DO UPDATE SET observed=excluded.observed,last_seen_at=now()`,
            [rule, alertRules[rule].level, values],
          );
        else
          await c.query(
            `UPDATE operational_alerts SET state='resolved',resolved_at=now(),version=version+1
          WHERE rule=$1 AND state<>'resolved'`,
            [rule],
          );
      }
      // Samples contain only aggregate process counters. Keep 7 days for charts.
      await c.query(
        "DELETE FROM operational_samples WHERE sampled_at<now()-interval '7 days'",
      );
      return { ...sample, data };
    });
    previous = stats;
    return result;
  }
  return {
    sample() {
      if (!pending)
        pending = collect().finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}
