/* 查询并核验景区主体，管理后台补充任务。 */

import { createAmapClient } from "../integrations/amap.mjs";
import { mainlandEligible, toGcj } from "../../public/coordinates.js";
import {
  selectParentPoi,
  readParent,
  poiPoint,
  overlayParentChecks,
} from "../domain/amap-parent.mjs";
import { deduplicateVisitPlaces } from "../domain/scenic-entities.mjs";
import { visitable, scorePlace } from "../domain/scenic-clusters.mjs";
import {
  loadParentChecks,
  saveParentCheck,
} from "../repositories/scenic-parents.mjs";
import { catalogRequest } from "./catalog.mjs";
import { pool } from "../db.mjs";
import { loadScenicHierarchy } from '../repositories/scenic-hierarchy.mjs';
import { overlayScenicHierarchy } from '../domain/scenic-hierarchy.mjs';

const client = createAmapClient({ provider: "AmapParent" });
export function createParentEnricher({
  call = client.call,
  load = loadParentChecks,
  save = saveParentCheck,
  catalog = catalogRequest,
  env = process.env,
  now = () => new Date().toISOString(),
} = {}) {
  async function run(
    input,
    { maxCalls = Infinity, onProgress = () => {}, beforeRequest = () => {} } = {},
  ) {
    const points = input.filter(visitable),
      originals = new Map(points.map((p) => [p.id, p]));
    const checks = await load(points),
      pois = new Map(),
      parentPlaces = new Map();
    let calls = 0,
      processed = 0,
      paused = null;
    const request = async (path, params) => {
      await beforeRequest();
      if (calls >= maxCalls)
        throw Object.assign(Error("batch limit"), {
          code: "batch_limit",
          status: 429,
        });
      calls++;
      const r = await call(path, params);
      for (const p of r.pois || []) pois.set(p.id, p);
      return r;
    };
    const detail = async (id) => {
      if (!pois.has(id)) await request("v5/place/detail", { id });
      return pois.get(id);
    };
    const findParentPlace = async (poi, child) => {
      if (parentPlaces.has(poi.id)) return parentPlaces.get(poi.id);
      const matching = (candidates) => {
        const found = deduplicateVisitPlaces(candidates)
          .flatMap((p) => {
            const match = selectParentPoi(p, [poi]);
            return match.status === "matched"
              ? [{ p, score: match.score }]
              : [];
          })
          .sort((a, b) => b.score - a.score);
        return found.length &&
          (!found[1] || found[0].score - found[1].score >= 0.04)
          ? found[0].p
          : null;
      };
      let parent = matching(points);
      const position = poiPoint(poi);
      if (!position) return null;
      if (!parent) {
        try {
          const local = await catalog("/places", {
            q: poi.name,
            category: "scenic",
            ...position,
            radius: 3000,
            limit: 30,
            region: "china",
          });
          parent = matching((local.items || []).filter(visitable));
        } catch {
        }
      }
      parent ||= {
        id: "amap:" + poi.id,
        name: poi.name,
        ...position,
        category: "attraction",
        traits: {},
        aliases: [],
        source: "Amap",
        source_url: "https://www.amap.com/place/" + poi.id,
        coord_system: "WGS84",
        coordinateRole: "provider_representative",
        hierarchyOnly: true,
      };
      parent = {
        ...parent,
        city: child.city,
        country: child.country || "CN",
        timezone: child.timezone || "Asia/Shanghai",
        district: parent.district || child.district,
      };
      parentPlaces.set(poi.id, parent);
      return parent;
    };
    const entities = deduplicateVisitPlaces(points).sort(
      (a, b) =>
        scorePlace(b).total - scorePlace(a).total || a.id.localeCompare(b.id),
    );
    for (const p of entities) {
      const records = p.sourceRecords
        .map((r) => originals.get(r.id))
        .filter(Boolean);
      if (records.every((r) => checks.has(r.id))) continue;
      let result = records
        .map((r) => checks.get(r.id))
        .find((r) => r && ["root", "child", "unsupported"].includes(r.status));
      if (!result) {
        if (!mainlandEligible(p)) result = { status: "unsupported" };
        else if (!env.AMAP_KEY) {
          paused = "not_configured";
          break;
        } else
          try {
            const r = await request("v5/place/around", {
              keywords: p.name,
              location: toGcj(p),
              radius: 3000,
              sortrule: "weight",
              page_size: 10,
            });
            const match = selectParentPoi(p, r.pois || []);
            if (match.status !== "matched") result = { status: match.status };
            else {
              let poi = match.poi,
                relation = readParent(poi),
                seen = new Set([poi.id]);
              result = {
                status:
                  relation.state === "none" ? "root" : "parent_unresolved",
                poiId: poi.id,
                parentPoiId: relation.id,
                match: {
                  nameScore: match.nameScore,
                  distanceMeters: Math.round(match.meters),
                },
              };
              while (relation.state === "present") {
                if (seen.has(relation.id) || seen.size >= 10) {
                  result.status = "conflict";
                  break;
                }
                seen.add(relation.id);
                const parentPoi = await detail(relation.id);
                if (!parentPoi) break;
                const parent = await findParentPlace(parentPoi, p);
                if (!parent || records.some((r) => r.id === parent.id)) {
                  result.status = "conflict";
                  break;
                }
                poi = parentPoi;
                relation = readParent(poi);
                if (relation.state === "none") {
                  result = {
                    ...result,
                    status: "child",
                    parentId: parent.id,
                    rootPoiId: poi.id,
                    ancestors: [parent],
                    ancestorPoiIds: [...seen].slice(1),
                  };
                }
              }
            }
          } catch (e) {
            if (e.status === 429 || e.status === 503 || (e.providerCode && /^(100|400)/.test(e.providerCode))) {
              paused = e.code || e.providerCode || "provider_unavailable";
              break;
            }
            result = {
              status: "failed",
              errorCode: e.code || e.providerCode || "provider_unavailable",
            };
          }
      }
      result = { ...result, checkedAt: result.checkedAt || now() };
      for (const original of records) {
        await save(original, result);
        checks.set(original.id, result);
      }
      processed += records.length;
      await onProgress({ processed, calls, total: points.length });
    }
    const overlay = overlayParentChecks(points, checks);
    return {
      ...overlay,
      report: {
        ...overlay.coverage,
        processed,
        calls,
        paused,
        checkedAt: now(),
      },
    };
  }
  return { run };
}
const enrichment = createParentEnricher();
export const parentEnricher = {
  async run(points, options) {
    const connection = await pool.connect();
    let locked = false;
    let databaseLost = false;
    const disconnected = () => { databaseLost = true; };
    connection.on('error',disconnected);
    try {
      locked = (
        await connection.query(
          "SELECT pg_try_advisory_lock(20261012,1) AS locked",
        )
      ).rows[0].locked;
      if (!locked) {
        const current = await currentParentHierarchy(points);
        return {
          ...current,
          report: {
            ...current.coverage,
            calls: 0,
            processed: 0,
            paused: "worker_busy",
          },
        };
      }
      return await enrichment.run(points, {...options,beforeRequest:()=>{
        if(databaseLost)throw Object.assign(Error('Database connection unavailable'),{status:503,code:'database_unavailable'});
      }});
    } finally {
      try {
        if (locked)
          await connection.query("SELECT pg_advisory_unlock(20261012,1)");
      } finally {
        connection.removeListener('error',disconnected);
        connection.release(databaseLost);
      }
    }
  },
};
const jobs = new Map();
let queue = Promise.resolve();
export function queueParentChecks(city, points) {
  points = points.filter(p => !p.geometricHierarchy?.buildId);
  if (!points.length) return {status: 'geometry_hierarchy', calls: 0};
  if (
    process.env.AMAP_PARENT_LOOKUP_ENABLED !== "true" ||
    !process.env.AMAP_KEY
  )
    return { status: "disabled" };
  const old = jobs.get(city.id);
  if (
    old &&
    (old.status === "running" ||
      old.status === "queued" ||
      old.retryAt > Date.now())
  )
    return old;
  const job = {
    status: "queued",
    total: points.filter(visitable).length,
    processed: 0,
    calls: 0,
  };
  jobs.set(city.id, job);
  queue = queue
    .catch(() => {})
    .then(async () => {
      job.status = "running";
      try {
        const result = await parentEnricher.run(points, {
          onProgress: (p) => Object.assign(job, p),
        });
        Object.assign(job, result.report, {
          status: result.report.paused ? "paused" : "finished",
          retryAt: Date.now() + 30 * 60_000,
        });
      } catch {
        Object.assign(job, { status: "failed", retryAt: Date.now() + 60_000 });
      }
    });
  return job;
}
export async function currentParentHierarchy(points) {
  const eligible = points.filter(visitable);
  const provider = overlayParentChecks(eligible, await loadParentChecks(eligible));
  const offline = await loadScenicHierarchy(eligible);
  const places=overlayScenicHierarchy(provider.places, offline,
    {includeModelSuggestions:process.env.SCENIC_MODEL_GROUPING_ENABLED!=='false'});
  return {...provider, places,
    coverage: {...provider.coverage, offlineChecked: offline.size,
      modelSuggestedChildren:places.filter(p=>p.parentRelation?.status==='model_suggested').length,
      offlineChildren: [...offline.values()].filter(r => r.status === 'child').length}};
}
