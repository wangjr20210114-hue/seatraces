/* 预留和结算景区层级评估的模型预算。 */

import { transaction, query } from "../db.mjs";
import {
  modelCostUpper,
  modelUsageEstimate,
} from "../domain/hierarchy-assessment.mjs";
import {
  localApiLimitsEnabled,
  monthlyApiBudget,
} from "../domain/api-limits.mjs";

export function createHierarchyReservation({
  transact = transaction,
  env = process.env,
} = {}) {
  return async function reserveHierarchy(provider, body, batchBudget) {
    const reserve = modelCostUpper(body),
      monthlyBudget = monthlyApiBudget(env);
    const enabled = localApiLimitsEnabled(env);
    if (
      enabled &&
      (!Number.isFinite(batchBudget) ||
        batchBudget <= 0 ||
        !Number.isFinite(monthlyBudget) ||
        monthlyBudget <= 0)
    )
      throw Object.assign(Error("Invalid budget"), { code: "invalid_budget" });
    return transact(async (c) => {
      if (enabled) {
        await c.query("SELECT pg_advisory_xact_lock(20261023)");
        const used = (
          await c.query(
            `SELECT COALESCE(sum(reserved_cny) FILTER(WHERE created_at>=date_trunc('month',now())),0) monthly,
          COALESCE(sum(reserved_cny) FILTER(WHERE provider=$1),0) batch FROM api_usage`,
            [provider],
          )
        ).rows[0];
        if (Number(used.monthly) + reserve > monthlyBudget)
          throw Object.assign(Error("Monthly budget"), {
            code: "monthly_budget",
            status: 429,
          });
        if (Number(used.batch) + reserve > batchBudget)
          throw Object.assign(Error("Batch budget"), {
            code: "batch_budget",
            status: 429,
          });
      }
      const row = (
        await c.query(
          "INSERT INTO api_usage(provider,reserved_cny) VALUES($1,$2) RETURNING id",
          [provider, reserve],
        )
      ).rows[0];
      return { id: row.id, reservedCny: reserve };
    });
  };
}
export async function reserveHierarchyAssessment(
  provider,
  body,
  batchBudget,
  env = process.env,
) {
  return createHierarchyReservation({ env })(provider, body, batchBudget);
}
export async function settleHierarchyAssessment(reservation, usage) {
  const estimate = modelUsageEstimate(usage);
  if (!reservation || estimate === null) return null;
  const amount = Math.max(estimate, 0.0001);
  await query(
    "UPDATE api_usage SET reserved_cny=$2 WHERE id=$1 AND provider LIKE $3",
    [reservation.id, amount, "DeepSeekHierarchy:%"],
  );
  return amount;
}
