"""比较名称和来源证据，识别同一景点的重复记录。"""
import re
import unicodedata

VERSION = 'scenic-identity/1'
SCENIC = ('attraction', 'heritage', 'nature', 'leisure')
GENERIC = {'公园','博物馆','景点','景观','雕塑','凉亭','亭','遗址','入口','出口',
           'museum','park','monument','viewpoint','garden','temple','statue','memorial'}
SCOPE = re.compile(r'[东南西北]+(?:院区|区|馆|门|入口|出口)|(?:新|老)馆|[一二三四]期|停车场|售票处|游客中心')


def normalize(value):
    return ''.join(c for c in unicodedata.normalize('NFKC', str(value or '')).casefold() if c.isalnum())


def labels(row):
    values = [row['name'], *(row.get('aliases') or [])]
    return {n for v in values if len(n := normalize(v)) >= 2 and not n.isnumeric() and n not in GENERIC}


def identity_keys(row):
    tags = row.get('tags') or {}
    result = ['n:' + n for n in sorted(labels(row))]
    for k in ('wikidata', 'wikipedia'):
        value = tags.get(k)
        if value and (k != 'wikidata' or re.fullmatch(r'Q[1-9][0-9]*', value)):
            result.append(k + ':' + value)
    return result


def conflict(a, b):
    if a['category'] not in SCENIC or b['category'] not in SCENIC:
        return 'different_travel_role'
    at, bt = a.get('tags') or {}, b.get('tags') or {}
    if at.get('wikidata') and bt.get('wikidata') and at['wikidata'] != bt['wikidata']:
        return 'different_wikidata'
    if SCOPE.findall(normalize(a['name'])) != SCOPE.findall(normalize(b['name'])):
        return 'different_branch_or_facility'
    return None


def evidence(a, b, spatial):
    if conflict(a, b):
        return None
    shared = set(identity_keys(a)) & set(identity_keys(b))
    if not shared:
        return None
    strong = any(k.startswith(('wikidata:', 'wikipedia:')) for k in shared)
    kind = spatial.get('kind')
    if kind == 'point_area' and spatial.get('covered'):
        pass
    elif kind == 'area_area' and spatial.get('overlap', 0) >= .98:
        pass
    elif kind == 'point_point' and strong and spatial.get('distance', 999) <= 15:
        pass
    else:
        return None
    return dict(rule=VERSION, matchedKeys=sorted(shared), spatial=spatial)


def rank(row):
    return (-row.get('dimension', 0), -row.get('area_m2', 0),
            0 if row['id'].startswith('osm:relation/') else 1, row['id'])


def group_matches(records, matches):
    neighbours = {}
    for a, b, why in matches:
        neighbours.setdefault(a, {})[b] = why
        neighbours.setdefault(b, {})[a] = why
    assigned, result = set(), []
    for main in sorted(neighbours, key=lambda oid: rank(records[oid])):
        if main in assigned:
            continue
        members = [main]
        for candidate in sorted(neighbours[main], key=lambda oid: rank(records[oid])):
            if candidate in assigned:
                continue
            why = neighbours[main][candidate]
            if why.get('reviewed') or all(not conflict(records[candidate], records[m]) for m in members):
                members.append(candidate)
        if len(members) < 2:
            continue
        assigned.update(members)
        result.append((main, [(m, {'rule': VERSION, 'main': True} if m == main else neighbours[main][m]) for m in members]))
    return result


def aliases_for(records, canonical):
    result, seen = [], {normalize(canonical['name'])}
    for row in sorted(records, key=lambda r: r['id']):
        for value in [row['name'], *(row.get('aliases') or [])]:
            n = normalize(value)
            if n and not n.isnumeric() and n not in seen:
                result.append((value, row['id']))
                seen.add(n)
    return result
