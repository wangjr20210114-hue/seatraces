import { z } from "zod";
import { explicitStyle } from "./memory.mjs";

const vague =
  /^(随便|都行|你看着办|不知道|不清楚|没想好|再说吧|嗯|啊|好的|可以|随意)[吧啊呀。！! ]*$/;
const city = /^[\p{L}][\p{L} .·-]{0,24}$/u;
export const isSoftwareQuestion = (text) =>
  /你(?:能|会)(?:做|干)什么|你有什么功能|介绍.{0,5}(你|功能)|(?:怎么|如何|为什么|为何).{0,30}(行程|规划|改|选择|保存|软件|海迹|操作|使用)/.test(
    text,
  );
export const bypassConfirmation = (text) =>
  /(不用|无需|不要|不必|跳过|绕过).{0,5}确认|直接.{0,5}(保存|执行|删|发布)/.test(
    text,
  );

// Only explicit spans are extracted. Dates without a year are deliberately left for clarification.
export function travelFields(text, questionKey) {
  const fields = {};
  const origins = [
    ...text.matchAll(/从\s*([^，。！？\d\s]{1,20}?)(?:出发|到|去)/g),
  ].map((m) => m[1]);
  if (new Set(origins).size > 1 && !/(不是|说错|改口|改成|改为)/.test(text))
    return {
      conflict: "origin",
      candidates: [...new Set(origins)].filter((n) => city.test(n)),
    };
  const origin = text.match(
    /(?:从\s*([^，。！？\d\s]{1,20}?)(?:出发|到|去)|出发(?:地|城市)(?:改成|改为|换成|是|为|还是|仍然是|[:：])\s*([^，。！？\d\s]{1,20}))/,
  );
  const destination =
    text.match(
      /目的(?:地|城市)(?:改成|改为|换成|是|为|还是|仍然是|[:：])\s*([^，。！？\d\s]{1,20})/,
    ) ||
    text.match(
      /(?:想去|改去|去|到)\s*([^，。！？\d\s]{1,20}?)(?:旅游|旅行|游玩|玩|[，。！？\s]|$)/,
    );
  if (origin) fields.originName = origin[1] || origin[2];
  if (origins.length > 1 && /(不是|说错|改口|改成|改为)/.test(text))
    fields.originName = origins.at(-1);
  if (destination) fields.destinationName = destination[1];
  const correction = text.match(
    /(?:不是|不去|别选|不要).{1,20}?[，,；;]\s*(?:而?是|改成|改为|改去|换成)\s*([^，。！？\d\s]{1,20})/,
  );
  const role = ["origin", "originName"].includes(questionKey)
    ? "originName"
    : ["city", "destinationName"].includes(questionKey)
      ? "destinationName"
      : null;
  if (role === "originName" && !fields.originName) {
    const standalone = text.match(/^([^，。！？\d\s]{1,20})出发[。！! ]*$/);
    if (standalone) fields.originName = standalone[1];
  }
  if (correction && role) fields[role] = correction[1];
  const dates = [
    ...text.matchAll(/(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})日?/g),
  ].map((m) => `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  if (
    dates.length === 2 &&
    ["start", "end"].includes(questionKey) &&
    /不是|改成|改为/.test(text)
  )
    fields[questionKey] = dates[1];
  else if (dates.length === 2) [fields.start, fields.end] = dates;
  else if (dates.length === 1 && ["start", "end"].includes(questionKey))
    fields[questionKey] = dates[0];
  for (const k of ["originName", "destinationName"])
    if (fields[k] && (!city.test(fields[k]) || vague.test(fields[k])))
      delete fields[k];
  return fields;
}

const interpretation = z
  .object({
    kind: z.enum([
      "answer",
      "software_question",
      "change_task",
      "other",
      "unclear",
    ]),
    optionIndexes: z.array(z.number().int().min(0).max(99)).max(100),
    value: z.string().max(500).nullable(),
    evidence: z.string().max(500),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export async function understandAnswer(
  text,
  q,
  { model, enabled = false } = {},
) {
  if (isSoftwareQuestion(text)) return { kind: "software_question" };
  if (vague.test(text)) return { kind: "unclear" };
  if (/^(不要|别选|不去|不选|不是)[^，。！？,;；]+[。！! ]*$/.test(text))
    return { kind: "unclear" };
  if (["nickname", "title"].includes(q.key)) {
    const value = text
      .match(/(?:改成|改为|叫做|叫|设为)\s*[“"「]?([^”"」。！？]{1,80})/)?.[1]
      ?.trim();
    if (value) return { kind: "answer", value };
  }
  if (/^(改成|改为|换成)/.test(text)) {
    const value = text.replace(/^(改成|改为|换成)\s*/, "");
    if (
      ["origin", "originName", "city", "destinationName"].includes(q.key) &&
      city.test(value)
    )
      return { kind: "answer", value };
  }
  const normalized = text
    .replace(/^(我想选|我选|选|选中|选择)\s*/, "")
    .replace(/[。！! ]+$/, "");
  const matches = q.options.filter(
    (o) =>
      o.label === normalized ||
      (normalized.length >= 2 && o.label.includes(normalized)),
  );
  if (matches.length === 1 && !q.multi)
    return { kind: "answer", optionIds: [matches[0].id] };
  if (
    ["origin", "originName", "city", "destinationName"].includes(q.key) &&
    city.test(text) &&
    text.length <= 12 &&
    !/(你|我|朋友|明天|昨天|今天|帮|说|讲|可以|不|都|随便|怎样|什么|那个|这个|出发|走走|先去)/.test(
      text,
    )
  )
    return { kind: "answer", value: text };
  // Free form fields are still validated by their business schemas. Long city prose is never sent as a POI query.
  if (
    !q.options.length &&
    !["origin", "originName", "city", "destinationName"].includes(q.key)
  )
    return { kind: "answer", value: text };
  if (q.input && q.key === "title") return { kind: "answer", value: text };
  if (q.key === "style" && /朋友|他喜欢|她喜欢|例如|假如|如果/.test(text))
    return { kind: "unclear" };
  if (q.key === "style" && Object.keys(explicitStyle(text)).length)
    return { kind: "answer", value: text };
  if (enabled && model) {
    try {
      const r = interpretation.parse(
        await model(
          "判断用户是否在回答当前软件问题。只解释，不执行。kind为answer/software_question/change_task/other/unclear。answer只能从给出的选项选择零起始optionIndexes，或在允许输入时提取用户原文里的value。不要因为用户说随便就替他作决定。矛盾、不确定或答非所问返回unclear。解释软件问题返回software_question，提出另一件软件操作返回change_task。evidence必须是用户原文逐字片段，confidence为0到1。返回 {kind,optionIndexes,value,evidence,confidence}。不得生成任何工具、URL或动作参数。",
          {
            text,
            question: {
              key: q.key,
              text: q.text,
              multi: q.multi,
              allowsInput: !!q.input,
              options: q.options.map((o) => o.label),
            },
          },
          { maxTokens: 350 },
        ),
      );
      if (r.confidence < 0.85 || !r.evidence || !text.includes(r.evidence))
        return { kind: "unclear" };
      if (r.kind !== "answer") return { kind: r.kind };
      if (r.optionIndexes.length) {
        if (
          (!q.multi && r.optionIndexes.length !== 1) ||
          new Set(r.optionIndexes).size !== r.optionIndexes.length ||
          r.optionIndexes.some((i) => !q.options[i])
        )
          return { kind: "unclear" };
        return {
          kind: "answer",
          optionIds: r.optionIndexes.map((i) => q.options[i].id),
        };
      }
      if (
        q.input &&
        r.value &&
        text.includes(r.value) &&
        (!["origin", "originName", "city", "destinationName"].includes(q.key) ||
          city.test(r.value))
      )
        return { kind: "answer", value: r.value };
    } catch {}
  }
  return { kind: "unclear" };
}
