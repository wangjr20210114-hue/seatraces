import { distance } from "../planner.mjs";

const normalized = (s) =>
  String(s || "")
    .normalize("NFKC")
    .replace(/\s/g, "")
    .toLowerCase();
const names = (p) => [
  ...new Set(
    [p.name, ...(p.aliases || [])]
      .map(normalized)
      .filter((n) => n.length >= 2 && !/^\d+$/.test(n)),
  ),
];
const shortName = (s) =>
  s.replace(/^(.{2,})(?:博物院|博物馆|风景名胜区|风景区|景区)$/u, "$1");
const same = (a, b) => a.some((n) => b.includes(n));
const relationPriority = p => p.geometricHierarchy?.buildId ? 6 : p.parentRelation?.status==='model_suggested' ? 2
  : p.parentRelation?.status==='evidence_reviewed' ? 5
  : ['root','child'].includes(p.parentLookup?.status) ? 4 : p.parentLookup ? 1 : 0;

// Keep source records, rather than deleting duplicate OSM objects. A child sight is
// a separate place inside an area, not another name for that area.
function record(p) {
  const { sourceRecords, children, score, signals, wanted, ...rest } = p;
  return rest;
}
function sources(p) {
  return p.sourceRecords || [record(p)];
}
export function representedIds(p) {
  return [
    ...new Set([
      p.id,
      ...(p.possibleDuplicateIds || []),
      ...sources(p).map((r) => r.id),
      ...(p.children || []).flatMap(representedIds),
    ]),
  ];
}
export function applyWishes(p, wishes = {}) {
  const children = (p.children || []).map((c) => applyWishes(c, wishes));
  const ownIds = [p.id, ...(p.possibleDuplicateIds || [])];
  const ownWanted = ownIds.some((id) => wishes[id] === true);
  return {
    ...p,
    children,
    ownWanted,
    wanted: ownWanted || children.some((c) => c.wanted),
  };
}
export function deduplicateVisitPlaces(points) {
  const entities = [],
    index = new Map();
  for (const p of points) {
    const labels = names(p),
      keys = labels.map(shortName);
    const wikidata = p.traits?.wikidata;
    const candidates = new Set(keys.flatMap((k) => index.get("n:" + k) || []));
    if (wikidata)
      for (const c of index.get("w:" + wikidata) || []) candidates.add(c);
    const old = [...candidates].find((c) => {
      // The server has compared full geometry and identity evidence. Distinct
      // canonical IDs must not be merged again by the earlier radius heuristic.
      if (p.entityIdentity?.buildId || c.entityIdentity?.buildId)
        return p.id === c.id;
      const d = distance(c, p),
        other = names(c);
      const branch = (s) =>
        normalized(s)
          .match(/(?:[东南西北]+(?:院区|园|区|馆)|(?:新|老)馆|[一二三四]期)/gu)
          ?.join("|") || "";
      if (branch(c.name) !== branch(p.name)) return false;
      const generic =
        /^(景观|雕塑|公园|遗址|凉亭|亭|展馆|museum|park|monument)$/u;
      if (generic.test(normalized(p.name)) || generic.test(normalized(c.name)))
        return false;
      const areaAndPoint =
        /osm:(?:way|relation)\//.test(c.id) !==
        /osm:(?:way|relation)\//.test(p.id);
      return (
        (same(labels, other) && d <= (areaAndPoint ? 0.2 : 0.03)) ||
        (!same(labels, other) &&
          same(keys, other.map(shortName)) &&
          d <= 0.12) ||
        (wikidata && c.traits?.wikidata === wikidata && d <= 1)
      );
    });
    const entity = old || {
      ...p,
      sourceRecords: sources(p).map((r) => ({ ...r })),
      children: [...(p.children || [])],
    };
    if (old) {
      old.sourceRecords = [
        ...new Map(
          [...old.sourceRecords, ...sources(p)].map((r) => [r.id, r]),
        ).values(),
      ];
      old.possibleDuplicateIds = [
        ...new Set([
          ...(old.possibleDuplicateIds || []),
          p.id,
          ...(p.possibleDuplicateIds || []),
        ]),
      ].filter((id) => id !== old.id);
      old.aliases = [
        ...new Set(
          [...(old.aliases || []), p.name, ...(p.aliases || [])].filter(
            Boolean,
          ),
        ),
      ];
      old.children = [
        ...new Map(
          [...old.children, ...(p.children || [])].map((r) => [r.id, r]),
        ).values(),
      ];
      // An area and its POI marker can have different source IDs. Keep reviewed
      // facts attached to either representation when producing one visit entity.
      for (const [field, fact] of Object.entries(p.facts || {})) {
        const current = old.facts?.[field];
        if (
          !current ||
          (fact.status === "evidence_reviewed" &&
            current.status !== "evidence_reviewed") ||
          (current.value == null && fact.value != null)
        ) {
          old.facts ||= {};
          old.facts[field] = fact;
        }
      }
      old.childPlaceIds = [
        ...new Set([...(old.childPlaceIds || []), ...(p.childPlaceIds || [])]),
      ];
      if (relationPriority(p) > relationPriority(old)
          || (p.geometricHierarchy?.geometryState === 'full_geometry'
              && old.geometricHierarchy?.geometryState === 'mapped_point')) {
        old.parentLookup = p.parentLookup;
        old.parentId = p.parentId;
        old.parentRelation = p.parentRelation;
        old.hierarchyLevel = p.hierarchyLevel;
        if (p.geometricHierarchy) old.geometricHierarchy = p.geometricHierarchy;
      }
      old.wanted = Boolean(old.wanted || p.wanted);
      old.ownWanted = Boolean(old.ownWanted || p.ownWanted);
      if (p.visited) {
        old.visited = true;
        old.visitHistory ||= p.visitHistory;
      }
    } else entities.push(entity);
    for (const k of [
      ...keys.map((k) => "n:" + k),
      ...(wikidata ? ["w:" + wikidata] : []),
    ]) {
      const list = index.get(k) || [];
      if (!list.includes(entity)) index.set(k, [...list, entity]);
    }
  }
  return entities;
}

export function groupScenicEntities(points) {
  const entities = deduplicateVisitPlaces(points),
    parents = new Map(),
    byName = new Map(),
    byId = new Map(
      entities.flatMap((p) =>
        [
          p.id,
          ...(p.possibleDuplicateIds || []),
          ...sources(p).map((r) => r.id),
        ].map((id) => [id, p]),
      ),
    );
  for (const p of entities)
    for (const n of names(p)) {
      if (n.length >= 2) byName.set(n, [...(byName.get(n) || []), p]);
    }
  for (const child of entities) {
    // A completed Amap lookup is authoritative for this display policy. Empty
    // parent must not be undone by a name prefix; failed matches are not roots.
    if (child.parentLookup) {
      if (child.parentLookup.status === "child") {
        const parent = byId.get(child.parentId);
        if (parent && parent.id !== child.id) parents.set(child.id, parent);
      } else if (
        !["root"].includes(child.parentLookup.status) &&
        child.parentRelation?.status === "evidence_reviewed"
      ) {
        const parent = byId.get(child.parentId);
        if (parent && parent.id !== child.id) parents.set(child.id, parent);
      }
      continue;
    }
    // Explicit parent IDs / names, or an unambiguous "景区名·子景点" label.
    // Proximity alone never proves containment. Polygon-based grouping can be
    // added once the catalog exposes actual area geometries.
    const parentName =
      child.traits?.["is_in:attraction"] || child.traits?.["is_in:tourism"];
    const prefix = child.name?.match(/^(.{2,}?)[·・：:—－-](.{1,})$/u)?.[1];
    const explicit = byId.get(child.parentId);
    const candidates = explicit && explicit.id !== child.id ? [explicit] : [];
    for (const key of [parentName, prefix].filter(Boolean))
      for (const p of byName.get(normalized(key)) || [])
        if (p.id !== child.id) candidates.push(p);
    const near = [...new Map(candidates.map((p) => [p.id, p])).values()].filter(
      (p) => distance(child, p) <= 3,
    );
    if (near.length === 1) parents.set(child.id, near[0]);
  }
  // Cards aggregate descendants for planning, while geometric parent/depth
  // fields keep the persisted hierarchy. displayParentId identifies the card.
  const roots = new Map(), inferredPaths = new Set();
  for (const child of entities) {
    let parent = parents.get(child.id),
      root = parent;
    const seen = new Set([child.id]);
    let inferred=child.parentRelation?.status==='model_suggested';
    while (parent) {
      if (seen.has(parent.id)) {
        root = null;
        break;
      }
      seen.add(parent.id);
      root = parent;
      if(parents.has(parent.id) && parent.parentRelation?.status==='model_suggested') inferred=true;
      parent = parents.get(parent.id);
    }
    if (root) { roots.set(child.id, root); if(inferred)inferredPaths.add(child.id); }
  }
  for (const child of entities) {
    const root = roots.get(child.id);
    if (root) {
      root.children.push({
        ...child,
        children: [],
        hierarchyLevel: child.geometricHierarchy?.buildId ? child.hierarchyLevel : 2,
        parentId: child.geometricHierarchy?.buildId ? child.parentId : root.id,
        displayParentId: root.id,
        groupingReviewNeeded: inferredPaths.has(child.id),
        groupingEvidence:
          inferredPaths.has(child.id)
            ? "model_with_osm_containment"
            : child.parentRelation?.provider === "amap"
            ? "amap_parent"
            : child.parentRelation?.status === "source_supported"
              ? child.parentRelation.method
            : child.parentRelation?.status === "evidence_reviewed"
              ? "official_source_reviewed"
              : child.parentId
                ? "explicit_parent_id"
                : "explicit_parent_name",
      });
      root.wanted ||= child.wanted;
    }
  }
  return entities
    .filter((p) => !roots.has(p.id))
    .map((p) => ({
      ...p,
      entityType: p.children.length ? "scenic_area" : "place",
      hierarchyLevel: p.geometricHierarchy?.buildId ? p.hierarchyLevel : 1,
      sourceRecordCount: representedIds(p).length,
    }));
}

export function clusterInventory(clusters) {
  const entities = clusters.flatMap((c) => c.members);
  const ids = new Set(entities.flatMap(representedIds));
  return {
    clusterCount: clusters.length,
    placeCount: entities.length,
    childCount: entities.reduce((n, p) => n + (p.children?.length || 0), 0),
    sourceRecordCount: ids.size,
  };
}
