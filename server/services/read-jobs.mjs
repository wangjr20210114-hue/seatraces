// Short polling responses keep a slow city read independent of HTTP deadlines.
// Keys are scoped to an authenticated user + session; rejected jobs can retry.
export function createReadJobs({ now = Date.now, ttlMs = 5 * 60_000 } = {}) {
  const jobs = new Map();
  return function readJob(key, work) {
    for (const [id, job] of jobs)
      if (job.finishedAt && now() - job.finishedAt > ttlMs) jobs.delete(id);
    let job = jobs.get(key);
    if (!job) {
      if (jobs.size >= 24) {
        const completed = [...jobs].find(([, value]) => value.finishedAt);
        if (completed) jobs.delete(completed[0]);
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
          },
          (error) => {
            Object.assign(job, { status: "failed", error, finishedAt: now() });
          },
        );
    }
    if (job.status === "failed") {
      jobs.delete(key);
      throw job.error;
    }
    return job.status === "ready"
      ? job.result
      : { status: "loading", retryAfterMs: 1500 };
  };
}
