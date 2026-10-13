export const unavailable = (provider, message) => ({
  status: "not_configured",
  provider,
  message,
  items: [],
  checkedAt: new Date().toISOString(),
});
