"""分批提取景区边界和几何数据，保存处理进度。"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
import osmium
from shapely.geometry import Point, Polygon, LineString, mapping, shape
from shapely.ops import polygonize_full, unary_union
from shapely.strtree import STRtree

VERSION = 'osm-scenic-geometry/1'
CITIES = ['beijing', 'shanghai', 'gn-1809858', 'gn-1795565', 'hangzhou']


def stamp():
    return datetime.now(timezone.utc).isoformat()


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
    temporary.replace(path)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def oid(kind, number):
    return 'osm:' + {'n': 'node', 'w': 'way', 'r': 'relation'}[kind] + '/' + str(number)


def scenic_container(p):
    tags = p.get('rawTags') or p.get('traits') or {}
    if tags.get('boundary') in ('administrative', 'political') or tags.get('admin_level') or tags.get('area') == 'no' or tags.get('access') in ('no', 'private'):
        return False
    return (tags.get('tourism') in ('attraction', 'museum', 'zoo', 'theme_park', 'aquarium')
            or tags.get('leisure') in ('park', 'garden', 'nature_reserve')
            or tags.get('historic') in ('castle', 'archaeological_site', 'fort', 'palace'))


def polygon_from_members(members, ways, nodes):
    rings = {'outer': [], 'inner': []}
    for member in members:
        if member['type'] != 'w' or member['role'] not in ('', 'outer', 'inner'):
            if member['type'] == 'r':
                raise ValueError('nested_relation_geometry_unsupported')
            continue
        refs = ways.get(str(member['ref']), {}).get('nodes')
        if not refs or any(str(n) not in nodes for n in refs):
            raise ValueError('incomplete_relation_geometry')
        rings[member['role'] or 'outer'].append(LineString([nodes[str(n)] for n in refs]))
    polygons = {}
    for role, lines in rings.items():
        if not lines:
            polygons[role] = None
            continue
        polys, cuts, dangles, invalid = polygonize_full(lines)
        if not cuts.is_empty or not dangles.is_empty or not invalid.is_empty or polys.is_empty:
            raise ValueError('unclosed_relation_ring')
        polygons[role] = unary_union(polys)
    outer, inner = polygons['outer'], polygons['inner']
    if outer is None:
        raise ValueError('missing_outer_ring')
    if inner is not None:
        if not outer.covers(inner):
            raise ValueError('inner_outside_outer')
        outer = outer.difference(inner)
    if outer.is_empty or not outer.is_valid:
        raise ValueError('invalid_polygon')
    return outer


def infer(points, geometries, site_members):
    by_id = {p['id']: p for p in points}
    parents = [(pid, g) for pid, g in geometries.items()
               if pid in by_id and g.geom_type in ('Polygon', 'MultiPolygon')
               and scenic_container(by_id[pid])]
    tree = STRtree([g for _, g in parents]) if parents else None
    explicit = {}
    for parent_id, members in site_members.items():
        if parent_id not in by_id or not scenic_container(by_id[parent_id]):
            continue
        for member in members:
            if member['role'] not in ('', 'part', 'member'):
                continue
            child_id = oid(member['type'], member['ref'])
            if child_id in by_id and child_id != parent_id:
                explicit.setdefault(child_id, set()).add(parent_id)
    results = []
    for p in points:
        pid = p['id']
        geometry = geometries.get(pid)
        if geometry is None and pid.startswith('osm:node/'):
            geometry = Point(p['lng'], p['lat'])
        candidates = []
        if tree is not None and geometry is not None:
            for index in tree.query(geometry):
                parent_id, area = parents[index]
                if parent_id == pid or not area.covers(geometry) or area.equals(geometry):
                    continue
                parent = by_id[parent_id]
                same_name = parent['name'].strip() == p['name'].strip()
                same_wiki = p.get('rawTags', {}).get('wikidata') and p['rawTags']['wikidata'] == parent.get('rawTags', {}).get('wikidata')
                if same_name or same_wiki:
                    continue
                candidates.append({'parentId': parent_id, 'parentName': parent['name'],
                                   'method': 'polygon_covers', 'areaDegrees2': area.area,
                                   'boundaryTouch': area.boundary.intersects(geometry)})
        candidates.sort(key=lambda c: (c['areaDegrees2'], c['parentId']))
        direct = sorted(explicit.get(pid, set()))
        direct = [parent for parent in direct if not (
            parent in geometries and geometry is not None
            and geometries[parent].geom_type in ('Polygon', 'MultiPolygon')
            and not geometries[parent].covers(geometry))]
        result = {'placeId': pid, 'name': p['name'], 'city': p['city'],
                  'status': 'unknown', 'parentId': None, 'method': None,
                  'candidates': candidates, 'siteCandidates': sorted(explicit.get(pid, set())),
                  'geometryAvailable': geometry is not None}
        if len(direct) == 1:
            result.update(status='child', parentId=direct[0], method='osm_site_member')
        elif candidates:
            result.update(status='spatial_candidate', method='polygon_covers')
        if len(direct) > 1 or (explicit.get(pid) and not direct):
            result.update(status='conflict', method='osm_site_conflict')
        tags = p.get('rawTags') or {}
        parent_name = tags.get('is_in:tourism') or tags.get('is_in:attraction')
        matches = [c for c in candidates if parent_name and parent_name in
                   [by_id[c['parentId']]['name'], *by_id[c['parentId']].get('aliases', [])]
                   and not c['boundaryTouch']]
        if result['status'] != 'conflict' and len(matches) == 1:
            if result['parentId'] and result['parentId'] != matches[0]['parentId']:
                result.update(status='conflict', parentId=None, method='contradicting_osm_evidence')
            else:
                result.update(status='child', parentId=matches[0]['parentId'], method='osm_explicit_name_and_polygon')
        results.append(result)
    parent_map = {r['placeId']: r['parentId'] for r in results if r['status'] == 'child'}
    for row in results:
        seen, current = set(), row['placeId']
        while current in parent_map:
            if current in seen:
                row.update(status='conflict', parentId=None, method='cycle')
                break
            seen.add(current)
            current = parent_map[current]
    return results


def run(project, output, recompute=False):
    started = time.monotonic()
    manifest_path = project / 'data/osm/raw/china-manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf8'))
    pbf = manifest_path.parent / manifest['path']
    snapshots = [project / '.runtime/five-city-parents' / (city + '.json') for city in CITIES]
    fingerprint = hashlib.sha256((VERSION + manifest['sha256'] + ''.join(digest(p) for p in snapshots)).encode()).hexdigest()
    workspace = output / fingerprint[:20]
    workspace.mkdir(parents=True, exist_ok=True)
    status = {'algorithm': VERSION, 'fingerprint': fingerprint, 'startedAt': stamp(), 'status': 'running', 'phase': 'verify_source'}

    def progress(phase, **extra):
        status.update(phase=phase, elapsedSeconds=round(time.monotonic()-started, 2), updatedAt=stamp(), **extra)
        atomic(output / 'extraction-status.json', status)
        print(json.dumps(status, ensure_ascii=False), flush=True)

    try:
        progress('verify_source')
        if digest(pbf) != manifest['sha256']:
            raise ValueError('source_checksum_mismatch')
        if (workspace / 'result.json').exists() and not recompute:
            result = json.loads((workspace / 'result.json').read_text(encoding='utf8'))
            atomic(output / 'geometry-result.json', result)
            progress('complete', status='complete', cached=True)
            return
        points = []
        for path in snapshots:
            data = json.loads(path.read_text(encoding='utf8'))
            for p in data['places']:
                points.append({**p, 'cityId': data['city']['id'], 'city': data['city']['name']})
        targets = {p['id'] for p in points}
        rels, ways, nodes, tags_by_id = {}, {}, {}, {}

        class Relations(osmium.SimpleHandler):
            def relation(self, r):
                tags = dict(r.tags)
                members = [{'type': m.type, 'ref': m.ref, 'role': m.role} for m in r.members]
                if oid('r', r.id) in targets or (tags.get('type') == 'site' and any(oid(m['type'], m['ref']) in targets for m in members)):
                    rels[str(r.id)] = {'tags': tags, 'members': members}

        class Ways(osmium.SimpleHandler):
            def way(self, w):
                if w.id in needed_ways:
                    ways[str(w.id)] = {'nodes': [n.ref for n in w.nodes], 'tags': dict(w.tags)}

        class Nodes(osmium.SimpleHandler):
            last_progress = time.monotonic()
            def node(self, n):
                if n.id in needed_nodes and n.location.valid():
                    nodes[str(n.id)] = [n.lon, n.lat]
                    if oid('n', n.id) in targets:
                        tags_by_id[oid('n', n.id)] = dict(n.tags)
                    if time.monotonic()-self.last_progress > 15:
                        progress('nodes', retainedNodes=len(nodes), requestedNodes=len(needed_nodes))
                        self.last_progress=time.monotonic()

        def scan(phase, handler, bit, ids=None):
            begin = time.monotonic()
            progress(phase)
            with osmium.io.Reader(str(pbf), bit) as reader:
                handlers = [osmium.filter.IdFilter(ids), handler] if ids is not None else [handler]
                osmium.apply(reader, *handlers)
            status.setdefault('phaseSeconds', {})[phase] = round(time.monotonic()-begin, 2)

        path = workspace / 'relations.json'
        if path.exists():
            rels = json.loads(path.read_text(encoding='utf8'))
        else:
            scan('relations', Relations(), osmium.osm.osm_entity_bits.RELATION)
            atomic(path, rels)
        needed_ways = {int(p.split('/')[1]) for p in targets if p.startswith('osm:way/')}
        needed_ways.update(m['ref'] for rid, r in rels.items() if oid('r', rid) in targets
                           and r['tags'].get('type') in ('multipolygon', 'boundary') for m in r['members'] if m['type'] == 'w')
        path = workspace / 'ways.json'
        if path.exists():
            ways = json.loads(path.read_text(encoding='utf8'))
        else:
            scan('ways', Ways(), osmium.osm.osm_entity_bits.WAY, needed_ways)
            atomic(path, ways)
        needed_nodes = {n for w in ways.values() for n in w['nodes']}
        needed_nodes.update(int(p.split('/')[1]) for p in targets if p.startswith('osm:node/'))
        path = workspace / 'nodes.json'
        if path.exists():
            saved = json.loads(path.read_text(encoding='utf8'))
            nodes, tags_by_id = saved['nodes'], saved['tags']
        else:
            scan('nodes', Nodes(), osmium.osm.osm_entity_bits.NODE, needed_nodes)
            atomic(path, {'nodes': nodes, 'tags': tags_by_id})
        progress('assemble', retainedNodes=len(nodes), retainedWays=len(ways), retainedRelations=len(rels))
        geometries, issues, sites = {}, Counter(), {}
        for p in points:
            pid = p['id']; kind, number = pid[4:].split('/')
            try:
                if kind == 'node':
                    if number in nodes:
                        geometries[pid] = Point(nodes[number])
                elif kind == 'way':
                    way = ways.get(number)
                    if not way:
                        raise ValueError('missing_way')
                    tags_by_id[pid] = way['tags']
                    refs = way['nodes']
                    if len(refs) < 2 or any(str(n) not in nodes for n in refs):
                        raise ValueError('incomplete_way')
                    coordinates = [nodes[str(n)] for n in refs]
                    geometry = Polygon(coordinates) if len(refs) >= 4 and refs[0] == refs[-1] else LineString(coordinates)
                    if not geometry.is_valid or geometry.is_empty:
                        raise ValueError('invalid_way_geometry')
                    geometries[pid] = geometry
                else:
                    rel = rels.get(number)
                    if not rel:
                        raise ValueError('missing_relation')
                    tags_by_id[pid] = rel['tags']
                    if rel['tags'].get('type') == 'site':
                        sites[pid] = rel['members']
                    elif rel['tags'].get('type') in ('multipolygon', 'boundary'):
                        geometries[pid] = polygon_from_members(rel['members'], ways, nodes)
            except ValueError as error:
                issues[str(error)] += 1
            p['rawTags'] = tags_by_id.get(pid, {})
        progress('infer')
        rows = infer(points, geometries, sites)
        counts = Counter(r['status'] for r in rows)
        result = {'algorithm': VERSION, 'fingerprint': fingerprint, 'generatedAt': stamp(),
                  'source': manifest, 'sourceSnapshotAt': manifest.get('http_last_modified'),
                  'coordinateSystem': 'WGS84', 'cities': CITIES, 'points': points,
                  'geometries': {pid: mapping(g) for pid, g in geometries.items() if g.geom_type in ('Polygon', 'MultiPolygon')},
                  'results': rows, 'summary': {'total': len(points), 'statuses': dict(counts),
                  'geometries': len(geometries), 'polygons': sum(g.geom_type in ('Polygon', 'MultiPolygon') for g in geometries.values()),
                  'siteRelations': len(sites), 'orphanSiteRelations': sum(oid('r', rid) not in targets for rid in rels),
                  'issues': dict(issues), 'phaseSeconds': status.get('phaseSeconds', {}),
                  'elapsedSeconds': round(time.monotonic()-started, 2)}}
        atomic(workspace / 'result.json', result)
        atomic(output / 'geometry-result.json', result)
        progress('complete', status='complete', summary=result['summary'])
    except Exception as error:
        progress('failed', status='failed', error=type(error).__name__)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--output', type=Path)
    parser.add_argument('--recompute', action='store_true', help='Reapply rules using saved relation/way/node checkpoints')
    args = parser.parse_args()
    run(args.project.resolve(), args.output or args.project / '.runtime/scenic-hierarchy', args.recompute)
