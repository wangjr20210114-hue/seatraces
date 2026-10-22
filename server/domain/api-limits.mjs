// Application spending/count caps are opt-in. Provider quotas and request
// pacing are independent, and usage is recorded in either mode.
export function localApiLimitsEnabled(env = process.env) {
  return (
    String(env.API_LOCAL_LIMITS_ENABLED || "false")
      .trim()
      .toLowerCase() === "true"
  );
}

export function monthlyApiBudget(env = process.env) {
  return localApiLimitsEnabled(env)
    ? Number(env.API_MONTHLY_BUDGET_CNY || 200)
    : null;
}

export function apiBudgetStatus(reserved, env = process.env) {
  const limit = monthlyApiBudget(env);
  return {
    limit,
    unlimited: limit === null,
    reserved: Number(reserved),
    note: "请求预留估算，并非供应商账单",
  };
}
