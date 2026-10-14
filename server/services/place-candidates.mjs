import { candidateQuery } from "../contracts/candidates.mjs";
import {
  fromOsm,
  fromAmap,
  categoryMatches,
  normalizeName,
} from "../domain/place-candidate.mjs";
import { nameSimilarity } from "../domain/place-matching.mjs";
import { distance } from "../planner.mjs";
import { mainlandEligible, toGcj } from "../../public/coordinates.js";
import { catalogRequest } from "./catalog.mjs";
import { searchAmapAround } from "../integrations/amap.mjs";
import { semanticRanking } from "./semantic-ranking.mjs";

const keywords = {
  scenic: "景点|博物馆|公园",
  accommodation: "酒店|民宿|青年旅舍",
  food: "餐饮",
  rest: "公共厕所|休息区",
  transport: "火车站|地铁站|汽车站",
};
const regions = {
  CN: "china",
  TW: "taiwan",
  JP: "japan",
  KR: "south-korea",
  TH: "thailand",
  VN: "vietnam",
  MV: "maldives",
};
// A floor for automatic substitution, not a calibrated identity probability.
const SEMANTIC_FLOOR = 0.65;
function select(items, query) {
  const ranked = items
    .filter(
      (p) =>
        p?.quality.searchUsable &&
        categoryMatches(p.classification.category, query.category),
    )
    .map((p) => {
      const meters = distance(query, p.location.point) * 1000;
      const score = query.q
        ? Math.max(
            ...[p.name, ...p.aliases].map((n) => nameSimilarity(query.q, n)),
          )
        : 1;
      return {
        ...p,
        match: {
          distanceMeters: Math.round(meters),
          nameScore: Number(score.toFixed(3)),
          semanticSimilarity: p.semantic?.cosine ?? null,
          rankScore: p.semantic ? Number(p.semantic.cosine.toFixed(6)) : score,
          requiresNameConfirmation: false,
          substituted: Boolean(query.q && score < 0.75),
          basis:
            query.q && score < 0.75
              ? p.semantic
                ? "semantic_best_substitute"
                : "insufficient_name_match"
              : query.q
                ? "name_similarity"
                : "category_and_area",
          withinRequestedRadius: meters <= query.radius,
        },
      };
    })
    .filter(
      (p) =>
        p.match.withinRequestedRadius &&
        (!p.location.countryCode ||
          p.location.countryCode === query.countryCode) &&
        (!query.q ||
          p.match.nameScore >= 0.75 ||
          p.semantic?.cosine >= SEMANTIC_FLOOR),
    )
    .sort(
      (a, b) =>
        Number(b.match.nameScore >= 0.999) -
          Number(a.match.nameScore >= 0.999) ||
        b.match.rankScore - a.match.rankScore ||
        a.match.distanceMeters - b.match.distanceMeters,
    );
  const unique = [];
  for (const p of ranked) {
    const duplicate = unique.find(
      (x) =>
        x.id === p.id ||
        (normalizeName(x.name) === normalizeName(p.name) &&
          distance(x.location.point, p.location.point) * 1000 < 100),
    );
    if (duplicate) {
      if (duplicate.id !== p.id) {
        duplicate.possibleDuplicateIds = [
          ...(duplicate.possibleDuplicateIds || []),
          p.id,
        ];
        duplicate.quality.needsReview.push(
          "possible_duplicate_group_not_verified",
        );
      }
    } else unique.push(p);
  }
  return unique;
}
export function createCandidateService({
  localSearch = catalogRequest,
  amapSearch = searchAmapAround,
  env = process.env,
  clock = () => new Date().toISOString(),
  rankSemantic = semanticRanking,
} = {}) {
  return async function searchCandidates(input) {
    const query = candidateQuery.parse(input),
      now = clock();
    const required =
      query.intent === "named"
        ? 1
        : (query.minCandidates ??
          (query.intent === "named" ? 1 : Math.min(5, query.limit)));
    let local = { status: "unavailable", items: [] };
    try {
      local = await localSearch("/places", {
        q: query.q,
        category: query.category,
        lat: query.lat,
        lng: query.lng,
        radius: query.radius,
        limit: Math.min(60, Math.max(20, query.limit * 3)),
        region: regions[query.countryCode],
      });
    } catch (e) {
      if (e.status === 400) throw e;
    }
    const eligible = (p) =>
      p?.quality.searchUsable &&
      categoryMatches(p.classification.category, query.category) &&
      distance(query, p.location.point) * 1000 <= query.radius &&
      (!p.location.countryCode || p.location.countryCode === query.countryCode);
    const embedding = [];
    async function rank(items, stage) {
      const candidates = items.filter(eligible);
      if (env.EMBEDDING_ENABLED !== "true") return candidates;
      const result = await rankSemantic(query, candidates);
      const { items: ranked, ...metadata } = result;
      embedding.push({ stage, ...metadata });
      return ranked;
    }
    let localItems = select(
      await rank(
        (local.items || []).map((row) =>
          fromOsm(row, local, query.category, now),
        ),
        "local",
      ),
      query,
    );
    // Different names need a recall step before embedding can compare them.
    const spatialRecall = { attempted: false, received: 0 };
    if (
      query.intent === "named" &&
      !localItems.length &&
      env.EMBEDDING_ENABLED === "true"
    ) {
      spatialRecall.attempted = true;
      try {
        const nearby = await localSearch("/places", {
          q: "",
          category: query.category,
          lat: query.lat,
          lng: query.lng,
          radius: query.radius,
          limit: 60,
          region: regions[query.countryCode],
        });
        spatialRecall.received = nearby.items?.length || 0;
        localItems = select(
          await rank(
            (nearby.items || []).map((row) =>
              fromOsm(row, nearby, query.category, now),
            ),
            "local_spatial",
          ),
          query,
        );
        if (localItems.length) local = nearby;
      } catch (e) {
        if (e.status === 400) throw e;
        spatialRecall.status = "unavailable";
      }
    }
    const reasons =
      localItems.length >= required
        ? []
        : [localItems.length ? "below_minimum" : "no_usable_local_candidates"];
    if (!["live", "snapshot"].includes(local.status))
      reasons.push("local_unavailable");
    const fallback = {
      attempted: false,
      requests: 0,
      status: "not_needed",
      reason: null,
    };
    let supplied = [];
    if (localItems.length < required) {
      if (query.fallback === "never") fallback.status = "disabled";
      else if (!mainlandEligible({ ...query, country: query.countryCode }))
        fallback.status = "unsupported_region";
      else if (!env.AMAP_KEY) fallback.status = "not_configured";
      else {
        fallback.attempted = true;
        // One bounded page. No crawl, paid retry, second geocoding, or LLM call.
        fallback.requests = 1;
        try {
          const response = await amapSearch({
            keywords: query.q || keywords[query.category],
            location: toGcj(query),
            radius: query.radius,
            limit: 25,
            sort: "weight",
            details: true,
          });
          supplied = select(
            await rank(
              (response.pois || []).map((p, providerRank) => {
                const candidate = fromAmap(p, query.category, now);
                return candidate
                  ? { ...candidate, retrieval: { providerRank } }
                  : null;
              }),
              "amap",
            ),
            query,
          );
          fallback.status = supplied.length ? "live" : "empty";
        } catch (e) {
          fallback.status =
            e.status === 429 ? "budget_or_rate_limited" : "unavailable";
          fallback.reason = "外部补充暂不可用；保留本地候选，不自动重试";
        }
      }
    }
    // Source facts are never merged or persisted. Near-name duplicate grouping is only for this candidate list.
    const items = select([...localItems, ...supplied], query).slice(
      0,
      query.intent === "named" ? 1 : query.limit,
    );
    const sufficient = items.length >= required;
    const requiresSelection = items.some(
      (p) => p.match.requiresNameConfirmation,
    );
    return {
      schemaVersion: "candidate-search/1",
      status: sufficient
        ? requiresSelection
          ? "needs_selection"
          : "ready"
        : items.length
          ? "partial"
          : "empty",
      items,
      query,
      sufficiency: {
        scope: "search_only",
        required,
        localUsable: localItems.length,
        returned: items.length,
        sufficient,
        requiresSelection,
        reasons,
        ruleVersion: "single-best-name-075-semantic-065/1",
      },
      local: {
        status: local.status,
        received: local.items?.length || 0,
        cachedAt: local.cachedAt || null,
      },
      fallback,
      embedding,
      spatialRecall,
      selection: {
        mode: query.intent === "named" ? "single_best" : "discovery",
        semanticFloor: SEMANTIC_FLOOR,
        originalQuery: query.q,
        resolvedName: query.intent === "named" ? items[0]?.name || null : null,
        identityVerified: false,
      },
      attribution: [
        "© OpenStreetMap contributors · ODbL-1.0",
        ...(supplied.length ? ["高德地图"] : []),
      ],
      message:
        "候选可用于选点；开放时间、票价和入口仍需核验。高德补充仅限本次请求，不写入 OSM 库。",
      assembledAt: now,
    };
  };
}
export const searchCandidates = createCandidateService();
