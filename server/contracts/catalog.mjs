import { z } from "zod";

const osmId = z.string().regex(/^osm:(node|way|relation)\/\d{1,20}$/);
export const siteQuery = z.object({
  id: osmId,
  category: z.enum(["attraction", "heritage", "nature", "leisure", "accommodation",
    "food", "rest", "transport", "shopping", "settlement", "service"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  after: osmId.optional(),
}).strict();

export const catalogQuery = z
  .object({
    q: z.string().trim().max(120).default(""),
    category: z
      .enum([
        "scenic",
        "attraction",
        "heritage",
        "nature",
        "leisure",
        "accommodation",
        "food",
        "rest",
        "transport",
        "shopping",
        "settlement",
        "service",
      ])
      .optional(),
    region: z
      .string()
      .regex(/^[a-z-]{2,50}$/)
      .optional(),
    subcategory: z
      .string()
      .regex(/^[a-z_]{1,50}$/)
      .optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radius: z.coerce.number().min(1).max(50000).default(10000),
    limit: z.coerce.number().int().min(1).max(60).default(30),
  })
  .refine(
    (b) => (b.lat === undefined) === (b.lng === undefined),
    "经纬度必须同时提供",
  )
  .refine(
    (b) => b.q.length >= 2 || b.lat !== undefined,
    "请输入至少两个字符，或提供附近搜索中心",
  );
