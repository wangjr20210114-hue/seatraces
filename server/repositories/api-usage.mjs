import { transaction } from "../db.mjs";
import {
  localApiLimitsEnabled,
  monthlyApiBudget,
} from "../domain/api-limits.mjs";

export function apiLimits(provider, env = process.env) {
  if (!localApiLimitsEnabled(env)) return { daily: null, total: null };
  const group = provider.startsWith("Google")
    ? "Google"
    : provider.startsWith("Amap")
      ? "Amap"
      : provider;
  const defaults = { Amap: 300, DeepSeek: 50, Google: 30 };
  const key = group.toUpperCase() + "_DAILY_REQUEST_LIMIT";
  return {
    daily: Number(env[key] || defaults[group] || 50),
    total: Number(env.API_DAILY_REQUEST_LIMIT || 400),
  };
}
export function createApiReservation({
  transact = transaction,
  env = process.env,
} = {}) {
  return async function reserveApiCall(provider) {
    await transact(async (c) => {
      const cost = Number(
          provider === "AmapParent"
            ? env.AMAP_PARENT_REQUEST_RESERVE_CNY || 0.003
            : provider.startsWith("Google")
              ? env.GOOGLE_REQUEST_RESERVE_CNY || 0.5
              : env.API_REQUEST_RESERVE_CNY || 0.1,
        ),
        budget = monthlyApiBudget(env);
      if (!Number.isFinite(cost) || cost <= 0)
        throw Object.assign(new Error("接口费用估算配置无效"), { status: 503 });
      if (localApiLimitsEnabled(env)) {
        if (!Number.isFinite(budget) || budget < 0)
          throw Object.assign(new Error("接口预算配置无效"), { status: 503 });
        await c.query("SELECT pg_advisory_xact_lock(20261023)");
        const used = Number(
          (
            await c.query(
              "SELECT COALESCE(sum(reserved_cny),0) n FROM api_usage WHERE created_at>=date_trunc('month',now())",
            )
          ).rows[0].n,
        );
        const limits = apiLimits(provider, env);
        const daily = (
          await c.query(
            "SELECT count(*) FILTER (WHERE provider<>'AmapParent' AND provider NOT LIKE 'DeepSeekHierarchy:%') n,count(*) FILTER (WHERE provider=$1 OR ($1='Google' AND provider LIKE 'Google%')) provider_n FROM api_usage WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')",
            [
              provider.startsWith("Google")
                ? "Google"
                : provider.startsWith("Amap")
                  ? "Amap"
                  : provider,
            ],
          )
        ).rows[0];
        if (
          !Number.isSafeInteger(limits.daily) ||
          limits.daily < 1 ||
          !Number.isSafeInteger(limits.total) ||
          limits.total < 1
        )
          throw Object.assign(new Error("接口限额配置无效"), { status: 503 });
        // Keep the existing hierarchy count exemption in the optional capped mode.
        if (
          provider !== "AmapParent" &&
          (Number(daily.n) >= limits.total ||
            Number(daily.provider_n) >= limits.daily)
        )
          throw Object.assign(
            new Error(
              `已达到本程序今日${Number(daily.n) >= limits.total ? "总" : provider.startsWith("Amap") ? "地图" : "模型"}调用限额，问卷仍保留，可稍后重试`,
            ),
            { status: 429, code: "local_daily_limit" },
          );
        if (used + cost > budget)
          throw Object.assign(new Error("本月接口请求预算已达到限制"), {
            status: 429,
            code: "local_monthly_budget",
          });
      }
      await c.query(
        "INSERT INTO api_usage(provider,reserved_cny) VALUES($1,$2)",
        [provider, cost],
      );
    });
  };
}
export const reserveApiCall = createApiReservation();
