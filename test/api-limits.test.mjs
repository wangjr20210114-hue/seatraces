import test from "node:test";
import assert from "node:assert/strict";
import { apiBudgetStatus } from "../server/domain/api-limits.mjs";
import {
  apiLimits,
  createApiReservation,
} from "../server/repositories/api-usage.mjs";
import { createHierarchyReservation } from "../server/repositories/hierarchy-budget.mjs";
import { createJsonRequester } from "../server/integrations/http.mjs";
import { createAmapClient } from "../server/integrations/amap.mjs";

function ledger({
  monthly = 999999,
  total = 999999,
  own = 999999,
  batch = 999999,
} = {}) {
  const entries = [];
  const reads = [];
  return {
    entries,
    reads,
    transact: async (fn) =>
      fn({
        query: async (sql, args) => {
          if (sql.startsWith("INSERT INTO api_usage")) {
            entries.push({ provider: args[0], amount: args[1] });
            return { rows: [{ id: entries.length }] };
          }
          reads.push(sql);
          if (sql.includes("sum(reserved_cny)"))
            return { rows: [{ n: monthly, monthly, batch }] };
          if (sql.includes("count(*)"))
            return { rows: [{ n: total, provider_n: own }] };
          return { rows: [] };
        },
      }),
  };
}

const previousCaps = {
  API_DAILY_REQUEST_LIMIT: "400",
  AMAP_DAILY_REQUEST_LIMIT: "300",
  DEEPSEEK_DAILY_REQUEST_LIMIT: "50",
  GOOGLE_DAILY_REQUEST_LIMIT: "30",
  QWEATHER_DAILY_REQUEST_LIMIT: "50",
  API_MONTHLY_BUDGET_CNY: "200",
};

test("existing daily and monthly settings do not cap calls by default or with false", async () => {
  for (const mode of [undefined, "false"]) {
    const env = { ...previousCaps, API_LOCAL_LIMITS_ENABLED: mode };
    const db = ledger();
    const reserve = createApiReservation({ transact: db.transact, env });
    for (const provider of [
      "Amap",
      "AmapParent",
      "DeepSeek",
      "GooglePlaces",
      "GoogleRoutes",
      "QWeather",
      "Juhe",
    ]) {
      await reserve(provider);
      assert.deepEqual(apiLimits(provider, env), { daily: null, total: null });
    }
    assert.equal(db.entries.length, 7);
    assert.ok(
      db.entries.every(
        (entry) => Number.isFinite(entry.amount) && entry.amount > 0,
      ),
    );
    assert.equal(db.reads.length, 0);
  }
});

test("unused local cap values cannot reject calls while limits are disabled", async () => {
  const db = ledger();
  await createApiReservation({
    transact: db.transact,
    env: {
      API_LOCAL_LIMITS_ENABLED: "false",
      API_DAILY_REQUEST_LIMIT: "0",
      AMAP_DAILY_REQUEST_LIMIT: "invalid",
      API_MONTHLY_BUDGET_CNY: "invalid",
    },
  })("Amap");
  assert.equal(db.entries.length, 1);
});

test("status reports unlimited explicitly instead of the dormant 200 CNY cap", () => {
  const status = JSON.parse(
    JSON.stringify(apiBudgetStatus("1234.5", previousCaps)),
  );
  assert.equal(status.limit, null);
  assert.equal(status.unlimited, true);
  assert.equal(status.reserved, 1234.5);
  assert.equal(
    apiBudgetStatus(0, { ...previousCaps, API_LOCAL_LIMITS_ENABLED: "true" })
      .limit,
    200,
  );
});

test("uncapped application calls still return upstream quota errors once, without retrying", async () => {
  const db = ledger();
  let requests = 0;
  const requestJSON = createJsonRequester({
    reserve: createApiReservation({ transact: db.transact, env: previousCaps }),
    fetchImpl: async () => {
      requests++;
      return {
        ok: true,
        json: async () => ({ status: "0", infocode: "10021" }),
      };
    },
  });
  const client = createAmapClient({
    env: { AMAP_KEY: "TEST_ONLY" },
    requestJSON,
    schedule: (fn) => fn(),
  });
  await assert.rejects(
    client.call("v3/config/district", { keywords: "上海" }),
    (error) => error.status === 429 && error.providerCode === "10021",
  );
  assert.equal(requests, 1);
  assert.equal(db.entries.length, 1);
});

test("hierarchy assessments bypass both monthly and batch ceilings but keep the reservation", async () => {
  const db = ledger();
  const reserve = createHierarchyReservation({
    transact: db.transact,
    env: previousCaps,
  });
  const result = await reserve(
    "DeepSeekHierarchy:test",
    { messages: [{ content: "测试地点" }] },
    0.001,
  );
  assert.equal(result.id, 1);
  assert.ok(result.reservedCny > 0);
  assert.equal(db.entries[0].amount, result.reservedCny);
  assert.equal(db.reads.length, 0);
});

test("opt-in hierarchy budgets still reject a spent monthly or batch allowance", async () => {
  for (const [usage, code] of [
    [{ monthly: 200, batch: 0 }, "monthly_budget"],
    [{ monthly: 0, batch: 20 }, "batch_budget"],
  ]) {
    const db = ledger(usage);
    const reserve = createHierarchyReservation({
      transact: db.transact,
      env: { ...previousCaps, API_LOCAL_LIMITS_ENABLED: "true" },
    });
    await assert.rejects(
      reserve("DeepSeekHierarchy:test", { messages: [] }, 20),
      (error) => error.code === code,
    );
    assert.equal(db.entries.length, 0);
  }
});
