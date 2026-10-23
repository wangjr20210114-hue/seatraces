/* 管理异步读取任务，复用结果并提供任务状态。 */

export function createReadJobs({
  now = Date.now,
  ttlMs = 5 * 60_000,
  deliveredTtlMs = 15000,
} = {}) {
  const jobs = new Map();
  const expire = (key, job, ms) => {
    clearTimeout(job.timer);
    job.expiresAt = now() + ms;
    job.timer = setTimeout(() => {
      if (jobs.get(key) === job) jobs.delete(key);
    }, ms);
    job.timer.unref?.();
  };
  const remove = (key) => {
    clearTimeout(jobs.get(key)?.timer);
    jobs.delete(key);
  };
  return function readJob(key, work) {
    for (const [id, job] of jobs)
      if (job.expiresAt && now() >= job.expiresAt) remove(id);
    let job = jobs.get(key);
    if (!job) {
      if (jobs.size >= 24) {
        const completed = [...jobs].find(([, value]) => value.finishedAt);
        if (completed) remove(completed[0]);
        else
          throw Object.assign(Error("城市查询繁忙，请稍后重试"), {
            status: 429,
          });
      }
      job = { status: "loading" };
      jobs.set(key, job);
      Promise.resolve()
        .then(work)
        .then(
          (result) => {
            Object.assign(job, { status: "ready", result, finishedAt: now() });
            expire(key, job, ttlMs);
          },
          (error) => {
            Object.assign(job, { status: "failed", error, finishedAt: now() });
            expire(key, job, ttlMs);
          },
        );
    }
    if (job.status === "failed") {
      remove(key);
      throw job.error;
    }
    if (job.status === "ready" && !job.delivered) {
      job.delivered = true;
      expire(key, job, Math.min(ttlMs, deliveredTtlMs));
    }
    return job.status === "ready"
      ? job.result
      : { status: "loading", retryAfterMs: 1500 };
  };
}
