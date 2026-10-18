import { questionBank } from "../planner.mjs";
import { z } from "zod";
import { llmJSON } from "../integrations/deepseek.mjs";

export function orderedInterestOptions(options, preferences = {}) {
  const explicit = new Set(preferences.interests || []);
  const weight = (tag) => {
    const value = preferences.tagWeights?.[tag] ?? preferences.styleWeights?.[tag];
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  };
  // Keep every option and its stable tie order. An absent or negative signal
  // must not become a recommendation merely because its key exists.
  return options.map((tag, index) => ({ tag, index })).sort((a, b) =>
    Number(explicit.has(b.tag)) - Number(explicit.has(a.tag)) ||
    weight(b.tag) - weight(a.tag) || a.index - b.index).map(x => x.tag);
}

export async function personalizedQuestions(preferences, { model = llmJSON, enabled = Boolean(process.env.DEEPSEEK_API_KEY) } = {}) {
  let bank = structuredClone(questionBank),
    source = "本地问题库";
  bank[0].options = orderedInterestOptions(bank[0].options, preferences);
  const strong = bank[0].options.filter(tag =>
    (preferences.interests || []).includes(tag) ||
    (preferences.tagWeights?.[tag] ?? preferences.styleWeights?.[tag] ?? 0) >= .3).slice(0, 2);
  if (strong.length) bank[0].title = `这次也想逛${strong.join("、")}，还是换个主题？`;
  if (enabled) {
    try {
      const r = z
        .object({
          ids: z
            .array(z.enum(["interests", "pace", "transport"]))
            .min(1)
            .max(3),
        })
        .parse(
          await model(
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
