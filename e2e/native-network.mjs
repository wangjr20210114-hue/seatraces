/* 为模拟器测试配置网络请求行为。 */

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw Error("External network disabled for catalog regression");
  return originalFetch(input, init);
};
