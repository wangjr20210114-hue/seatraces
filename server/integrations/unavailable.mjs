/* 生成外部服务不可用时的统一结果。 */

export const unavailable = (provider, message) => ({
  status: "not_configured",
  provider,
  message,
  items: [],
  checkedAt: new Date().toISOString(),
});
