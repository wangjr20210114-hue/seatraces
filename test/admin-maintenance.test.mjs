import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { iterationFixture } from "./helpers/iteration-db.mjs";
import { installMaintenance } from "../server/operations/maintenance.mjs";
import { createMaintenanceWorker } from "../server/operations/maintenance-worker.mjs";
import {
  createHealthMonitor,
  healthDecisions,
} from "../server/operations/health-monitor.mjs";

test(
  "maintenance task permissions, durable execution, cancellation and alerts",
  { skip: process.env.TEST_OPERATIONS !== "1", timeout: 60000 },
  async (t) => {
    const f = await iterationFixture({
      schemas: ["operations/maintenance-schema.sql"],
    });
    let rejectAudit = false,
      executions = 0,
      failRun = false;
    const m = installMaintenance(f.app, {
      ...f,
      events: {
        ...f.events,
        append: async (...args) => {
          if (rejectAudit && args[0].action === "task.queued")
            throw Error("audit unavailable");
          return f.events.append(...args);
        },
      },
      extraExecutors: {
        health_check: async ({ checkpoint }) => {
          executions++;
          await checkpoint({ step: "verified" });
          if (failRun) throw Error("SECRET must never reach browser");
          return { ok: true };
        },
      },
    });
    const root = "/api/admin/maintenance";
    const queue = (id) =>
      f.request(root + "/tasks", {
        body: { id, kind: "health_check", confirmation: "run-task" },
      });
    const row = (id) =>
      f
        .query("SELECT * FROM maintenance_tasks WHERE id=$1", [id])
        .then((r) => r.rows[0]);
    try {
      await f.start();
      await t.test(
        "MT01 anonymous, ordinary and unsupported operations rejected; audited enqueue rollback",
        async () => {
          assert.equal(
            (await f.request(root + "/tasks", { user: null })).status,
            401,
          );
          for (const path of ["/tasks", "/health", "/alerts"])
            assert.equal(
              (await f.request(root + path, { user: "user" })).status,
              403,
            );
          assert.equal(
            (
              await f.request(root + "/tasks", {
                body: {
                  id: randomUUID(),
                  kind: "shell",
                  command: "whoami",
                  confirmation: "run-task",
                },
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await f.request(root + "/tasks", {
                body: { id: randomUUID(), kind: "health_check" },
              })
            ).status,
            400,
          );
          const id = randomUUID();
          rejectAudit = true;
          assert.equal((await queue(id)).status, 500);
          assert.equal(await row(id), undefined);
          rejectAudit = false;
        },
      );
      await t.test(
        "MT02 40 duplicate submits and 40 distinct submits create only one active task",
        async () => {
          const id = randomUUID();
          let responses = await Promise.all(
            Array.from({ length: 40 }, () => queue(id)),
          );
          assert.ok(responses.every((r) => r.status === 202));
          assert.equal(
            (await f.query("SELECT count(*)::int n FROM maintenance_tasks"))
              .rows[0].n,
            1,
          );
          responses = await Promise.all(
            Array.from({ length: 40 }, () => queue(randomUUID())),
          );
          assert.ok(responses.every((r) => r.status === 409));
          await Promise.all(Array.from({ length: 20 }, () => m.worker.tick()));
          assert.equal(executions, 1);
          assert.equal((await row(id)).state, "completed");
          assert.equal(
            (
              await f.query(
                "SELECT count(*)::int n FROM operation_events WHERE action='task.queued'",
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        "MT03 cancellation, failure sanitization, retry lineage and duplicate retry",
        async () => {
          const id = randomUUID();
          await queue(id);
          const r = await f.request(root + "/tasks/" + id + "/cancel", {
            body: { version: 1, confirmation: "cancel-task" },
          });
          assert.equal(r.status, 200);
          assert.equal(r.data.state, "cancelled");
          const cancelledExecutions = executions;
          await m.worker.tick();
          assert.equal(executions, cancelledExecutions);
          const retry = randomUUID();
          let responses = await Promise.all(
            Array.from({ length: 12 }, () =>
              f.request(root + "/tasks/" + id + "/retry", {
                body: { id: retry, version: 2, confirmation: "retry-task" },
              }),
            ),
          );
          assert.ok(responses.every((r) => r.status === 202));
          assert.equal(new Set(responses.map((r) => r.data.id)).size, 1);
          failRun = true;
          await m.worker.tick();
          assert.equal((await row(retry)).error_code, "TASK_FAILED");
          const detail = await f.request(root + "/tasks/" + retry);
          assert.ok(!JSON.stringify(detail.data).includes("SECRET"));
          const final = randomUUID();
          assert.equal(
            (
              await f.request(root + "/tasks/" + retry + "/retry", {
                body: { id: final, version: 3, confirmation: "retry-task" },
              })
            ).status,
            202,
          );
          failRun = false;
          await m.worker.tick();
          assert.equal((await row(final)).state, "completed");
          assert.equal((await row(final)).retry_of, retry);
          assert.equal(
            (
              await f.request(root + "/tasks/" + final + "/cancel", {
                body: { version: 3, confirmation: "cancel-task" },
              })
            ).status,
            409,
          );
        },
      );
      await t.test(
        "MT04 expired leases become interrupted and are never automatically replayed",
        async () => {
          const id = randomUUID();
          await f.query(
            "INSERT INTO maintenance_tasks(id,kind,state,worker_id,lease_until) VALUES($1,'health_check','running',$2,now()-interval '1 minute')",
            [id, randomUUID()],
          );
          const count = executions;
          await m.worker.tick();
          assert.equal((await row(id)).state, "interrupted");
          assert.equal(executions, count);
        },
      );
      await t.test(
        "MT05 separate workers cannot run concurrent tasks; cancellation observed at checkpoint",
        async () => {
          let started, release;
          const entered = new Promise((r) => {
              started = r;
            }),
            gate = new Promise((r) => {
              release = r;
            });
          let calls = 0;
          const executors = {
            health_check: async ({ checkpoint }) => {
              calls++;
              started();
              await gate;
              await checkpoint();
              return { ok: true };
            },
          };
          const a = createMaintenanceWorker({
              ...f,
              executors,
              leaseSeconds: 2,
            }),
            b = createMaintenanceWorker({ ...f, executors, leaseSeconds: 2 });
          const id = randomUUID();
          await queue(id);
          const job = a.tick();
          try {
            await entered;
            assert.equal(await b.tick(), null);
            assert.equal(calls, 1);
            await f.request(root + "/tasks/" + id + "/cancel", {
              body: { version: 2, confirmation: "cancel-task" },
            });
            release();
            await job;
            assert.equal((await row(id)).state, "cancelled");
          } finally {
            release();
            await a.close();
            await b.close();
          }
        },
      );
      await t.test(
        "MT06 monitor deduplicates concurrent alerts, acknowledgement and recovery",
        async () => {
          let critical = true,
            stats = { queued: 1200, dropped: 3, failed: 2 };
          const monitor = createHealthMonitor({
            ...f,
            events: { stats: () => stats },
            runtime: () => ({
              heapUsedBytes: critical ? 90 : 20,
              heapLimitBytes: 100,
              rssBytes: 150,
              uptimeSeconds: 9,
            }),
          });
          await f.query(
            "INSERT INTO operation_events(kind,action,status) SELECT 'request','POST /api/test',CASE WHEN n<=5 THEN 500 ELSE 200 END FROM generate_series(1,20)n",
          );
          await Promise.all(Array.from({ length: 25 }, () => monitor.sample()));
          assert.equal(
            (await f.query("SELECT count(*)::int n FROM operational_samples"))
              .rows[0].n,
            1,
          );
          let alerts = (await f.request(root + "/alerts")).data.items;
          assert.equal(alerts.length, 5);
          const alert = alerts.find((a) => a.rule === "heap_pressure");
          let r = await f.request(
            root + "/alerts/" + alert.id + "/acknowledge",
            { body: { version: 1, confirmation: "acknowledge-alert" } },
          );
          assert.equal(r.status, 200);
          r = await f.request(root + "/alerts/" + alert.id + "/acknowledge", {
            body: { version: 1, confirmation: "acknowledge-alert" },
          });
          assert.equal(r.status, 409);
          await monitor.sample();
          assert.equal(
            (
              await f.query(
                "SELECT state FROM operational_alerts WHERE id=$1",
                [alert.id],
              )
            ).rows[0].state,
            "acknowledged",
          );
          critical = false;
          stats = { queued: 0, dropped: 3, failed: 2 };
          await f.query(
            "UPDATE operation_events SET created_at=now()-interval '10 minutes' WHERE action='POST /api/test'",
          );
          await f.query(
            "UPDATE maintenance_tasks SET finished_at=now()-interval '2 days' WHERE state IN ('failed','interrupted')",
          );
          await monitor.sample();
          assert.equal(
            (await f.request(root + "/alerts")).data.items.length,
            0,
          );
          const health = (await f.request(root + "/health")).data;
          assert.equal(health.samples.length, 3);
          assert.ok(health.requestCoverage.includes("游客"));
          assert.ok(!JSON.stringify(health).includes("password"));
        },
      );
      await t.test("MT07 120 task/alert reads at concurrency 8", async () => {
        let count = 0;
        const ms = [];
        await Promise.all(
          Array.from({ length: 8 }, async () => {
            while (count < 120) {
              const index = count++;
              const start = performance.now();
              assert.equal(
                (await f.request(root + (index % 2 ? "/alerts" : "/tasks")))
                  .status,
                200,
              );
              ms.push(performance.now() - start);
            }
          }),
        );
        ms.sort((a, b) => a - b);
        console.log(
          "PRESSURE maintenance: 120 requests/concurrency 8, p95=" +
            Math.round(ms[114]) +
            "ms",
        );
      });
      await t.test(
        "MT08 all delegated management roles cannot read or execute maintenance",
        async () => {
          let version = 0;
          for (const role of ["operator", "support", "analyst"]) {
            const assigned = await f.request(
              "/api/admin/access/members/" + f.users.other.id,
              {
                method: "PUT",
                body: { role, version, confirmation: "change-role" },
              },
            );
            assert.equal(assigned.status, 200);
            version = assigned.data.version;
            const login = await f.request("/api/auth/admin/login", {
              user: null,
              body: { username: f.users.other.username, password: f.password },
            });
            assert.equal(login.status, 200);
            const headers = {
              Cookie: login.headers.get("set-cookie").split(";")[0],
            };
            for (const path of ["/tasks", "/health", "/alerts"])
              assert.equal(
                (await f.request(root + path, { user: null, headers })).status,
                403,
              );
            assert.equal(
              (
                await f.request(root + "/tasks", {
                  user: null,
                  headers,
                  body: {
                    id: randomUUID(),
                    kind: "health_check",
                    confirmation: "run-task",
                  },
                })
              ).status,
              403,
            );
          }
        },
      );
      await t.test(
        "MT09 active long job renews its lease; second worker does not steal it",
        async () => {
          let entered, release;
          const began = new Promise((r) => {
              entered = r;
            }),
            gate = new Promise((r) => {
              release = r;
            });
          const executors = {
            health_check: async ({ checkpoint }) => {
              entered();
              await gate;
              await checkpoint();
              return { ok: true };
            },
          };
          const a = createMaintenanceWorker({
              ...f,
              executors,
              leaseSeconds: 1,
            }),
            b = createMaintenanceWorker({ ...f, executors, leaseSeconds: 1 });
          const id = randomUUID();
          await queue(id);
          const running = a.tick();
          try {
            await began;
            await new Promise((r) => setTimeout(r, 1500));
            assert.equal(await b.tick(), null);
            assert.equal((await row(id)).state, "running");
            release();
            await running;
            assert.equal((await row(id)).state, "completed");
          } finally {
            release();
            await a.close();
            await b.close();
          }
        },
      );
    } finally {
      await m.close();
      await f.close();
    }
  },
);

test("health thresholds have meaningful denominators and exact boundaries", () => {
  assert.equal(healthDecisions({ requests: 10, errors: 10 }).api_errors, false);
  assert.equal(healthDecisions({ requests: 50, errors: 5 }).api_errors, true);
  assert.equal(healthDecisions({ requests: 51, errors: 5 }).api_errors, false);
  assert.equal(
    healthDecisions({ heapUsedBytes: 85, heapLimitBytes: 100 }).heap_pressure,
    true,
  );
  assert.equal(
    healthDecisions({ heapUsedBytes: 84, heapLimitBytes: 100 }).heap_pressure,
    false,
  );
});
