import { randomUUID } from "node:crypto";

const interrupted = () =>
  Object.assign(Error("Maintenance lease lost"), { code: "LEASE_LOST" });
export function createMaintenanceWorker({
  query,
  transaction,
  executors,
  intervalMs = 3000,
  leaseSeconds = 90,
}) {
  const workerId = randomUUID();
  let pending = null,
    timer,
    closed = false;
  async function claim() {
    return transaction(async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('seatraces.maintenance-claim',0))",
      );
      // Expired tasks are visible for review, never silently replayed.
      await c.query(`UPDATE maintenance_tasks SET state='interrupted',error_code='WORKER_INTERRUPTED',
        finished_at=now(),lease_until=NULL,version=version+1 WHERE state='running' AND lease_until<now()`);
      if (
        (
          await c.query(
            "SELECT 1 FROM maintenance_tasks WHERE state='running' LIMIT 1",
          )
        ).rowCount
      )
        return null;
      const row = (
        await c.query(
          "SELECT * FROM maintenance_tasks WHERE state='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
        )
      ).rows[0];
      if (!row) return null;
      return (
        await c.query(
          `UPDATE maintenance_tasks SET state='running',started_at=now(),worker_id=$2,
        lease_until=now()+($3::int*interval '1 second'),version=version+1 WHERE id=$1 RETURNING *`,
          [row.id, workerId, leaseSeconds],
        )
      ).rows[0];
    });
  }
  async function run() {
    const task = await claim();
    if (!task) return null;
    let lost = false;
    const renew = async () => {
      try {
        const r = await query(
          `UPDATE maintenance_tasks SET lease_until=now()+($3::int*interval '1 second')
        WHERE id=$1 AND worker_id=$2 AND state='running' AND lease_until>now()`,
          [task.id, workerId, leaseSeconds],
        );
        if (!r.rowCount) lost = true;
      } catch {
        lost = true;
      }
    };
    const heartbeat = setInterval(
      () => void renew(),
      Math.max(250, Math.floor((leaseSeconds * 1000) / 3)),
    );
    heartbeat.unref();
    const checkpoint = async (progress) => {
      if (lost) throw interrupted();
      const row = (
        await query(
          "SELECT state,worker_id,cancel_requested,lease_until>now() live FROM maintenance_tasks WHERE id=$1",
          [task.id],
        )
      ).rows[0];
      if (
        !row ||
        row.state !== "running" ||
        row.worker_id !== workerId ||
        !row.live
      )
        throw interrupted();
      if (row.cancel_requested)
        throw Object.assign(Error("Cancelled"), { code: "TASK_CANCELLED" });
      if (progress)
        await query(
          "UPDATE maintenance_tasks SET progress=$3 WHERE id=$1 AND worker_id=$2 AND state='running'",
          [task.id, workerId, progress],
        );
    };
    try {
      await checkpoint({ step: "starting" });
      if (!Object.hasOwn(executors, task.kind))
        throw Object.assign(Error("Unavailable task"), {
          code: "TASK_UNAVAILABLE",
        });
      const result = await executors[task.kind]({ task, checkpoint, workerId });
      await checkpoint();
      await query(
        `UPDATE maintenance_tasks SET state='completed',result=$3,progress='{"step":"completed"}',
        finished_at=now(),lease_until=NULL,version=version+1 WHERE id=$1 AND worker_id=$2 AND state='running'`,
        [task.id, workerId, result || {}],
      );
    } catch (error) {
      const code = [
        "TASK_CANCELLED",
        "LEASE_LOST",
        "TASK_UNAVAILABLE",
        "ARCHIVE_OVERSIZE",
        "ARCHIVE_INVALID",
        "ARCHIVE_CONFLICT",
        "ARCHIVE_SOURCE_CHANGED",
        "EXPORT_SOURCE_CHANGED",
        "EXPORT_ACCESS_REVOKED",
        "EXPORT_EXPIRED",
        "EXPORT_OVERSIZE",
      ].includes(error.code)
        ? error.code
        : "TASK_FAILED";
      await query(
        `UPDATE maintenance_tasks SET state=$3,error_code=$4,finished_at=now(),lease_until=NULL,version=version+1
        WHERE id=$1 AND worker_id=$2 AND state='running'`,
        [
          task.id,
          workerId,
          code === "TASK_CANCELLED"
            ? "cancelled"
            : code === "LEASE_LOST"
              ? "interrupted"
              : "failed",
          code,
        ],
      );
    } finally {
      clearInterval(heartbeat);
    }
    return task.id;
  }
  function tick() {
    if (closed) return Promise.resolve(null);
    if (!pending)
      pending = run().finally(() => {
        pending = null;
      });
    return pending;
  }
  return {
    tick,
    start() {
      if (!timer) {
        timer = setInterval(() => void tick().catch(() => {}), intervalMs);
        timer.unref();
      }
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await pending;
    },
  };
}
