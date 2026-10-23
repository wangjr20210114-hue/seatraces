/* 定义候选地点查询参数和校验规则。 */

import { z } from "zod";

export const candidateQuery = z
  .object({
    intent: z.enum(["named", "discover"]).default("named"),
    q: z.string().trim().max(80).default(""),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    city: z.string().trim().min(1).max(60).optional(),
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    radius: z.number().int().min(100).max(50000).default(15000),
    category: z
      .enum(["scenic", "accommodation", "food", "rest", "transport"])
      .default("scenic"),
    limit: z.number().int().min(1).max(20).default(10),
    minCandidates: z.number().int().min(1).max(10).optional(),
    fallback: z.enum(["auto", "never"]).default("auto"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.intent === "named" && value.q.length < 2)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "查找具体地点至少需要两个字符",
        path: ["q"],
      });
    if (value.minCandidates && value.minCandidates > value.limit)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "最少候选数不能超过返回上限",
        path: ["minCandidates"],
      });
  });
