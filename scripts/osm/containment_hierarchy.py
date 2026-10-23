"""根据几何包含关系构建并校验景区层级。"""
VERSION = 'osm-full-containment/1'
MAX_DEPTH = 8
SCENIC = ('attraction', 'heritage', 'nature', 'leisure')


def cap_forest(parents, max_depth=MAX_DEPTH):
    if not 2 <= max_depth <= 8:
        raise ValueError('max_depth must be between 2 and 8')
    paths = {}
    for start in sorted(set(parents) | set(parents.values())):
        trail, seen, here = [], set(), start
        while here not in paths:
            if here in seen:
                raise ValueError('containment cycle')
            seen.add(here)
            trail.append(here)
            if here not in parents:
                paths[here] = [here]
                trail.pop()
                break
            here = parents[here]
        for item in reversed(trail):
            paths[item] = paths[parents[item]] + [item]
    result = {}
    for child, parent in parents.items():
        path = paths[child]
        limited = len(path) > max_depth
        result[child] = dict(parent_id=path[max_depth-2] if limited else parent,
                             natural_parent_id=parent, root_id=path[0],
                             depth=min(len(path), max_depth), natural_depth=len(path),
                             depth_limited=limited)
    return result


def infer_fixture(places, geometries):
    from shapely.strtree import STRtree
    eligible = [(p['id'], geometries[p['id']]) for p in places
                if p.get('category') in SCENIC and not p.get('administrative', False)
                and p['id'] in geometries and geometries[p['id']].is_valid
                and not geometries[p['id']].is_empty
                and geometries[p['id']].geom_type in ('Polygon', 'MultiPolygon')]
    tree = STRtree([g for _, g in eligible]) if eligible else None
    parents = {}
    for child in places:
        cid = child['id']; geom = geometries.get(cid)
        if tree is None or geom is None or geom.is_empty or not geom.is_valid:
            continue
        candidates = [(area.area, pid) for index in tree.query(geom)
                      for pid, area in [eligible[index]]
                      if pid != cid and area.area > geom.area and area.covers(geom)]
        if candidates:
            parents[cid] = min(candidates)[1]
    return cap_forest(parents)
