/* 读取本地 API 限额配置，计算月度预算与使用状态。 */

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
