import test from "node:test";
import assert from "node:assert/strict";
import { createPacedQueue } from "../server/integrations/paced-queue.mjs";
import { createAmapClient } from "../server/integrations/amap.mjs";

test("concurrent requests are spaced, a rejection is not retried or allowed to block the queue", async () => {
  let clock = 0;
  const starts = [],
    schedule = createPacedQueue({
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
  const client = createAmapClient({
    env: { AMAP_KEY: "TEST_ONLY" },
    schedule,
    requestJSON: async () => {
      starts.push(clock);
      return starts.length === 2
        ? { status: "0", infocode: "10021" }
        : { status: "1" };
    },
  });
  const results = await Promise.allSettled(
    [1, 2, 3].map(() =>
      client.call("v3/config/district", { keywords: "杭州" }),
    ),
  );
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].reason.status, 429);
  assert.equal(results[1].reason.providerCode, "10021");
  assert.equal(results[2].status, "fulfilled");
  assert.deepEqual(starts, [0, 1200, 2400]);
});
