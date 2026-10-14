import { questionBank } from "../planner.mjs";
import { z } from "zod";
import { llmJSON } from "../integrations/deepseek.mjs";

export async function personalizedQuestions(preferences) {
  let bank = structuredClone(questionBank),
    source = "本地问题库";
  const preferred = Object.keys(preferences.tagWeights || {}).filter((x) =>
    bank[0].options.includes(x),
  );
  bank[0].options = [...new Set([...preferred, ...bank[0].options])];
  if (process.env.DEEPSEEK_API_KEY) {
    try {
      const r = z
        .object({
          ids: z
            .array(z.enum(["interests", "pace", "transport"]))
            .min(1)
            .max(3),
        })
        .parse(
          await llmJSON(
            '从 questionBank 选择并排序问题，返回 {"ids":["interests","pace","transport"]}。只允许提供的 id。',
            { preferences, questionBank: bank },
          ),
        );
      const ids = [...new Set([...r.ids, ...bank.map((x) => x.id)])];
      bank = ids.map((id) => bank.find((x) => x.id === id));
      source = "DeepSeek · 仅使用本地问题库";
    } catch (e) {
      source = "本地问题库 · 模型暂不可用";
    }
  }
  return { questions: bank, source };
}
