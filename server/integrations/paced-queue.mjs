/* 按设定间隔依次执行外部服务请求。 */

export function createPacedQueue({
  intervalMs = 1200,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let tail = Promise.resolve(),
    nextStart = 0;
  return (task) => {
    const result = tail.then(async () => {
      const wait = nextStart - now();
      if (wait > 0) await sleep(wait);
      nextStart = now() + intervalMs;
      return task();
    });
    tail = result.catch(() => {});
    return result;
  };
}
