// Ephemeral presentation only. Durable results and operation audit remain in PostgreSQL.
export function createProgress() {
  const runs = new Map();
  return {
    start(id, requestId) {
      for (const [key, run] of runs)
        if (Date.now() - run.updatedAt > 600000) runs.delete(key);
      const run = {
        requestId,
        status: "running",
        steps: [],
        updatedAt: Date.now(),
      };
      runs.set(id, run);
      return (label) => {
        if (runs.get(id) !== run) return;
        if (run.steps.at(-1) !== label)
          run.steps = [...run.steps, label].slice(-12);
        run.updatedAt = Date.now();
      };
    },
    finish(id, failed = false) {
      const run = runs.get(id);
      if (run) {
        run.status = failed ? "failed" : "completed";
        run.updatedAt = Date.now();
      }
    },
    read(id, requestId) {
      const r = runs.get(id);
      return r && r.requestId === requestId && Date.now() - r.updatedAt < 600000
        ? r
        : { requestId, status: "idle", steps: [] };
    },
  };
}
