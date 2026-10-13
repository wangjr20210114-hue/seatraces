"""OSM site membership, independent of POI category and spatial inference.

The relation is the parent. Geometry/label members remain in the source table
but do not become child places. Membership does not imply shared tickets,
ownership, opening hours or navigability. Never convert multipolygon rings.
"""
from collections import Counter, defaultdict

VERSION = 'osm-site-hierarchy/1'
TECHNICAL_ROLES = {'perimeter', 'outer', 'inner', 'label', 'admin_centre'}


def osm_id(kind, ref):
    return 'osm:' + {'n': 'node', 'w': 'way', 'r': 'relation'}[kind] + '/' + str(ref)


def cyclic_pairs(pairs):
    """Iterative Kosaraju: quarantine only edges within cyclic components."""
    pairs = set(pairs)
    graph, reverse = defaultdict(set), defaultdict(set)
    for parent, child in pairs:
        graph[parent].add(child)
        reverse[child].add(parent)
    nodes = set(graph) | set(reverse)
    seen, order = set(), []
    for node in sorted(nodes):
        if node in seen:
            continue
        seen.add(node)
        stack = [(node, iter(graph[node]))]
        while stack:
            here, children = stack[-1]
            nxt = next(children, None)
            if nxt is None:
                order.append(here)
                stack.pop()
            elif nxt not in seen:
                seen.add(nxt)
                stack.append((nxt, iter(graph[nxt])))
    component, sizes = {}, Counter()
    for node in reversed(order):
        if node in component:
            continue
        group = len(sizes)
        stack = [node]
        component[node] = group
        while stack:
            here = stack.pop()
            sizes[group] += 1
            for nxt in reverse[here]:
                if nxt not in component:
                    component[nxt] = group
                    stack.append(nxt)
    return {(p, c) for p, c in pairs
            if p == c or (component[p] == component[c] and sizes[component[p]] > 1)}


def build_graph(sites, objects):
    """sites must be a deduplicated, version-selected map of site relations.

    All members are retained, including unavailable objects and technical roles.
    Existing catalog categories are inputs, never inferred from their parent.
    Multiple parents are legitimate source facts; no arbitrary single-parent pick.
    """
    members, grouped = [], defaultdict(list)
    for parent_id, site in sorted(sites.items()):
        if site['tags'].get('type') != 'site':
            raise ValueError('Only type=site relations are accepted')
        for index, member in enumerate(site['members']):
            child_id = osm_id(member['type'], member['ref'])
            role = member.get('role', '')
            kind = 'technical' if role.strip().lower() in TECHNICAL_ROLES else 'member'
            row = dict(parent_id=parent_id, child_id=child_id,
                       member_index=index, role=role, membership_kind=kind)
            members.append(row)
            if kind == 'member':
                grouped[parent_id, child_id].append(role)
    cycles = cyclic_pairs(grouped)
    edges, parent_ids, child_counts = [], defaultdict(set), defaultdict(Counter)
    for (parent, child), roles in sorted(grouped.items()):
        status = 'cycle_conflict' if (parent, child) in cycles else 'source_reported'
        edges.append(dict(parent_id=parent, child_id=child,
                          roles=sorted(set(roles)), status=status))
        if status == 'source_reported':
            parent_ids[child].add(parent)
            child_counts[parent][objects.get(child, {}).get('category') or 'unclassified'] += 1
    all_ids = set(sites) | {m['child_id'] for m in members}
    cycle_children = {child for parent,child in cycles}
    summaries = []
    for obj_id in sorted(all_ids):
        parents = sorted(parent_ids[obj_id])
        counts = dict(child_counts[obj_id])
        cycle_conflict = obj_id in cycle_children
        status = ('multiple_parents' if len(parents) > 1 else 'source_reported' if parents
                  else 'cycle_conflict' if cycle_conflict else 'no_site_membership_recorded')
        summaries.append(dict(id=obj_id, parent_ids=parents,
                              child_count=sum(counts.values()), children_by_category=counts,
                              membership_status=status))
    return dict(members=members, edges=edges, summaries=summaries,
                counts=dict(siteRelations=len(sites), rawMembers=len(members),
                            technicalMembers=sum(m['membership_kind'] == 'technical' for m in members),
                            uniqueMemberships=len(edges), acceptedEdges=len(edges)-len(cycles),
                            cycleEdges=len(cycles), linkedObjects=sum(bool(s['parent_ids']) for s in summaries),
                            multipleParentObjects=sum(len(s['parent_ids']) > 1 for s in summaries)))
