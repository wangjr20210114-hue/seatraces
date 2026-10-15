import { z } from "zod";
import { interests } from "../planner.mjs";
export const styleSchema = z
  .object({
    pace: z.enum(["relaxed", "balanced", "full"]).optional(),
    transport: z.enum(["balanced", "fewTransfers", "fewWalking"]).optional(),
    crowd: z.enum(["avoid", "balanced", "lively"]).optional(),
    revisit: z.enum(["new", "either"]).optional(),
    interests: z.array(z.enum(interests)).max(10).optional(),
  })
  .strict();
export const styleLabels = {
  pace: "旅行节奏",
  transport: "出行偏好",
  crowd: "拥挤偏好",
  revisit: "重游偏好",
  interests: "兴趣",
};
export const valueLabels = {
  relaxed: "慢慢逛",
  balanced: "均衡",
  full: "充实一点",
  fewTransfers: "少换乘",
  fewWalking: "少走路",
  avoid: "避开拥挤",
  lively: "接受热闹",
  new: "探索新地方",
  either: "可以重游",
};
export const labelValue = (v) =>
  Array.isArray(v) ? v.join("、") || "暂不限定" : valueLabels[v] || v;
export const strength = (key, value) =>
  key === "interests"
    ? 1
    : ({
        relaxed: 0.2,
        balanced: 0.5,
        full: 0.85,
        fewTransfers: 0.9,
        fewWalking: 0.9,
        avoid: 0.9,
        lively: 0.1,
        new: 0.9,
        either: 0.3,
      }[value] ?? 0.5);
// Only first-person, explicit statements. Negations and contradictions do not become silent memory.
export function explicitStyle(text) {
  const result = {};
  const set = (k, pattern, v) => {
    if (pattern.test(text)) result[k] = v;
  };
  set(
    "pace",
    /(喜欢|希望|想|要|这次|平时|记住).{0,8}(轻松|慢慢|悠闲|休闲|少安排)/,
    "relaxed",
  );
  set(
    "pace",
    /(喜欢|希望|想|要|这次|平时|记住).{0,8}(充实|多安排|紧凑)/,
    "full",
  );
  set("transport", /(少走路|不想走太多|尽量不走路)/, "fewWalking");
  set("transport", /(少换乘|不想转车|尽量直达)/, "fewTransfers");
  set(
    "crowd",
    /(避开拥挤|避开人群|不喜欢人多|不喜欢热闹|喜欢清静|喜欢安静)/,
    "avoid",
  );
  set("crowd", /(?<!不)(喜欢热闹|接受热闹|不怕人多)/, "lively");
  set("revisit", /(想去新地方|不想重游|不想再去)/, "new");
  set("revisit", /(可以重游|喜欢重游|去过也想去)/, "either");
  if (/(我|这次|平时|记住).{0,12}(喜欢|偏爱|爱看|想看|想逛)/.test(text)) {
    const tags = interests.filter(
      (tag) =>
        text.includes(tag) &&
        !new RegExp(`不(?:太)?(?:喜欢|想看|想逛)?${tag}`).test(text),
    );
    if (tags.length) result.interests = tags;
  }
  // A negative/corrective complex statement is clarified, never guessed by lexical matching.
  if (
    /(并不|不是|别记|不要记|朋友|他喜欢|她喜欢|例如|假如|如果|不想少|不要少)/.test(
      text,
    )
  )
    return {};
  return styleSchema.parse(result);
}
export async function readMemory(query, userId) {
  const rows = (
    await query(
      "SELECT dimension,value,strength,confidence,evidence,source,version,updated_at,expires_at FROM user_travel_memory WHERE user_id=$1 ORDER BY dimension",
      [userId],
    )
  ).rows;
  return rows.map((r) => ({
    ...r,
    label: styleLabels[r.dimension],
    valueLabel: labelValue(r.value),
    active: new Date(r.expires_at) > new Date(),
    effectiveConfidence: Number(
      (
        r.confidence *
        Math.pow(
          0.5,
          Math.max(0, Date.now() - new Date(r.updated_at).getTime()) /
            (180 * 86400000),
        )
      ).toFixed(3),
    ),
  }));
}
export async function memoryPreferences(query, userId) {
  const rows = await readMemory(query, userId);
  return Object.fromEntries(
    rows.filter((r) => r.active).map((r) => [r.dimension, r.value]),
  );
}
export async function saveMemory(
  transaction,
  userId,
  values,
  evidence,
  expected = {},
) {
  const parsed = styleSchema.parse(values);
  return transaction(async (c) => {
    await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
    for (const [key, value] of Object.entries(parsed)) {
      const old = (
        await c.query(
          "SELECT version FROM user_travel_memory WHERE user_id=$1 AND dimension=$2",
          [userId, key],
        )
      ).rows[0];
      if ((old?.version || 0) !== (expected[key] || 0))
        throw Object.assign(Error("旅行风格已更新，请重新确认"), {
          status: 409,
        });
      await c.query(
        `INSERT INTO user_travel_memory(user_id,dimension,value,strength,confidence,evidence,source) VALUES($1,$2,$3,$4,1,$5,'user_confirmed')
    ON CONFLICT(user_id,dimension) DO UPDATE SET value=excluded.value,strength=excluded.strength,confidence=1,evidence=excluded.evidence,version=user_travel_memory.version+1,updated_at=now(),expires_at=now()+interval '180 days'`,
        [
          userId,
          key,
          JSON.stringify(value),
          strength(key, value),
          evidence.slice(0, 1000),
        ],
      );
    }
  });
}
