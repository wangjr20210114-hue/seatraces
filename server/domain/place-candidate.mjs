/* 将 OSM 和高德地点转换为统一候选地点结构。 */

import { toWgs } from "../../public/coordinates.js";

const text = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const date = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
export const normalizeName = (value) =>
  String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, "");
const factFields = [
  "openingHours",
  "lastEntry",
  "reservation",
  "fee",
  "ticketPrice",
  "stayMinutes",
  "access",
  "website",
  "phone",
  "wheelchair",
  "checkIn",
  "checkOut",
];
const missingFields = {
  scenic: [
    "openingHours",
    "lastEntry",
    "reservation",
    "ticketPrice",
    "stayMinutes",
  ],
  accommodation: [],
  food: [],
  rest: ["access", "openingHours"],
  transport: ["access"],
};
export const scenicCategories = new Set([
  "attraction",
  "heritage",
  "nature",
  "leisure",
]);
const validPoint = (point) =>
  Number.isFinite(point.lat) &&
  Number.isFinite(point.lng) &&
  Math.abs(point.lat) <= 90 &&
  Math.abs(point.lng) <= 180;
export function categoryMatches(category, requested) {
  return requested === "scenic"
    ? scenicCategories.has(category)
    : category === requested;
}
function fact(value, source, now, extra = {}) {
  const present =
    value !== null &&
    value !== undefined &&
    value !== "" &&
    !(Array.isArray(value) && !value.length);
  return {
    value: present ? value : null,
    status: present ? "source_reported" : "unknown",
    sourceRef: present ? source.id : null,
    retrievedAt: present ? now : null,
    sourceUpdatedAt: null,
    verifiedAt: null,
    validFrom: null,
    validThrough: null,
    ...extra,
  };
}
function finish(p, profile) {
  const missing = (missingFields[profile] || []).filter(
    (k) => p.facts[k].value === null,
  );
  p.quality = {
    searchUsable: Boolean(text(p.name) && p.id && validPoint(p.location.point)),
    missingForTravel: missing,
    needsReview: [
      "point_not_verified_entrance",
      ...(["accommodation", "food"].includes(profile)
        ? []
        : ["opening_and_prices_not_date_validated"]),
    ],
    scheduleReady: "not_evaluated",
    usage: ["accommodation", "food"].includes(profile)
      ? "nearby_recommendation"
      : "visit_candidate",
  };
  return p;
}
export function fromOsm(row, delivery, profile, now) {
  const retrievedAt =
    delivery.status === "snapshot" ? date(delivery.cachedAt) : now;
  const source = {
    id: "osm",
    provider: "OpenStreetMap",
    objectId: row.id,
    url: row.source_url || null,
    license: row.license || "ODbL-1.0",
    snapshotAt: date(row.source_timestamp),
    retrievedAt,
    persistence: "source_dataset",
  };
  const sources = [source];
  const facts = {};
  for (const key of factFields) {
    const f = row.facts?.[key];
    let origin = source;
    if (f?.sourceUrl && f.source !== "OpenStreetMap") {
      origin = {
        id: "editorial:" + key,
        provider: f.source || "editorial",
        objectId: row.id,
        url: f.sourceUrl,
        license: null,
        snapshotAt: null,
        retrievedAt: date(f.evidence?.retrievedAt) || date(f.recordedAt),
        persistence: "editorial_record",
      };
      sources.push(origin);
    }
    facts[key] = fact(f?.value ?? null, origin, origin.retrievedAt, {
      source: f?.source || null,
      sourceUrl: f?.sourceUrl || null,
      sourceTimestamp: f?.sourceTimestamp || null,
      sourceUpdatedAt: origin === source ? null : date(f?.sourceTimestamp),
      verifiedAt: date(f?.verifiedAt),
      ...(f?.evidence?.version === 1
        ? {
            status: f.status,
            evidence: f.evidence,
            reviewAfter: date(f.evidence.reviewAfter),
            validFrom: date(f.evidence.validFrom),
            validThrough: date(f.evidence.validThrough),
            reviewNote: "已核对官方原文；时效与临时变更仍受证据范围限制",
          }
        : f?.value != null && f?.verifiedAt
          ? {
              status: "source_reported",
              reviewNote: "历史核验记录；本次未核对有效期",
            }
          : {}),
    });
    const deadline = facts[key].reviewAfter;
    if (
      (deadline && Date.parse(deadline) <= Date.parse(now)) ||
      (facts[key].validThrough &&
        Date.parse(facts[key].validThrough) <= Date.parse(now)) ||
      (facts[key].validFrom &&
        Date.parse(facts[key].validFrom) > Date.parse(now))
    ) {
      facts[key].value = null;
      facts[key].status = "needs_review";
    }
  }
  return finish(
    {
      schemaVersion: "place-candidate/1",
      id: row.id,
      name: row.name,
      aliases: [
        ...new Set([...(row.aliases || []), ...(row.editorialAliases || [])]),
      ],
      classification: {
        category: row.category,
        subcategory: row.subcategory || null,
        ruleVersion: "source-category/1",
      },
      location: {
        point: { lat: row.lat, lng: row.lng, crs: "WGS84" },
        pointRole: row.coordinate_role || "unknown",
        countryCode: row.country || null,
        province: row.province || null,
        city: row.city || null,
        address: row.facts?.address?.value || null,
        adminStatus:
          row.countrySource === "extract_region_hint"
            ? "derived_hint"
            : "source_reported",
      },
      facts,
      sources,
      routingHint: null,
      normalization: row.normalization || null,
      parentId: row.parentId || null,
      hierarchyLevel: row.hierarchyLevel || null,
      geometricHierarchy: row.geometricHierarchy || null,
      entityIdentity: row.entityIdentity || null,
      possibleDuplicateIds: row.possibleDuplicateIds || [],
      sourceRecords: row.sourceRecords || undefined,
      delivery: {
        status: delivery.status,
        cachedAt: delivery.cachedAt || null,
        assembledAt: now,
      },
    },
    profile,
  );
}
function amapCategory(type) {
  if (/风景名胜|博物馆|美术馆|科技馆|天文馆|展览馆/.test(type))
    return "attraction";
  if (/住宿服务/.test(type)) return "accommodation";
  if (/餐饮服务/.test(type)) return "food";
  if (/交通设施服务/.test(type)) return "transport";
  if (/公共厕所|休息室|休息区/.test(type)) return "rest";
  return "service";
}
export function fromAmap(row, profile, now) {
  if (
    !text(row.id) ||
    !text(row.name) ||
    !/^[-\d.]+,[-\d.]+$/.test(row.location || "")
  )
    return null;
  const [lng, lat] = row.location.split(",").map(Number);
  if (!validPoint({ lat, lng })) return null;
  const wgs = toWgs(row.location)[0];
  if (!wgs) return null;
  const source = {
    id: "amap",
    provider: "Amap",
    objectId: row.id,
    url: null,
    license: null,
    snapshotAt: null,
    retrievedAt: now,
    persistence: "request_only",
  };
  const facts = Object.fromEntries(
    factFields.map((k) => [k, fact(null, source, now)]),
  );
  const business = row.business || {};
  facts.phone = fact(text(business.tel) || text(row.tel), source, now);
  facts.openingHours = fact(text(business.opentime_week), source, now);
  const p = finish(
    {
      schemaVersion: "place-candidate/1",
      id: "amap:" + row.id,
      name: row.name,
      aliases: text(business.alias) ? [business.alias] : [],
      classification: {
        category: amapCategory(String(row.type || "")),
        subcategory: text(row.type),
        ruleVersion: "amap-type-text/1",
      },
      location: {
        point: { lat: wgs[0], lng: wgs[1], crs: "WGS84" },
        pointRole: "mapped_point",
        countryCode: null,
        province: text(row.pname),
        city: text(row.cityname),
        address: text(row.address),
        adminStatus: "source_reported",
      },
      facts,
      sources: [source],
      routingHint: {
        provider: "amap",
        providerId: row.id,
        location: row.location,
        crs: "GCJ02",
      },
      delivery: { status: "live", cachedAt: null, assembledAt: now },
    },
    profile,
  );
  p.quality.needsReview.push(
    "wgs84_is_approximate_conversion",
    "supplier_candidate_requires_selection",
  );
  return p;
}
