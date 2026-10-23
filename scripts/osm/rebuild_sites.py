"""重建 OSM site 成员关系，校验后发布新版本。"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time

from site_hierarchy import VERSION, build_graph, osm_id, cyclic_pairs

ROOT = Path('/home/ubuntu/seatraces-osm')


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.part')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str), encoding='utf8')
    temp.replace(path)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(8*1024*1024), b''):
            h.update(block)
    return h.hexdigest()


def save_cache(path, value):
    temp = path.with_name(path.name + '.part')
    with gzip.open(temp, 'wt', encoding='utf8') as f:
        json.dump(value, f, ensure_ascii=False)
    temp.replace(path)


def read_cache(path):
    with gzip.open(path, 'rt', encoding='utf8') as f:
        return json.load(f)


def rank(obj):
    return (obj.get('version', 0), obj.get('timestamp') or '', obj.get('region') or '')


def choose(objects, obj):
    prior = objects.get(obj['id'])
    if prior is None or rank(obj) > rank(prior):
        objects[obj['id']] = obj


def metadata(obj, kind, region):
    result = dict(id=osm_id(kind, obj.id), tags=dict(obj.tags), version=obj.version,
                  timestamp=obj.timestamp.isoformat(), region=region)
    if kind == 'n' and obj.location.valid():
        result.update(lon=obj.lon, lat=obj.lat)
    return result


def scan_sites(source, cache, emit):
    import osmium
    target = cache / (source['pbf_sha256'] + '-sites.json.gz')
    if target.exists():
        return read_cache(target)
    sites = {}
    class Handler(osmium.SimpleHandler):
        def relation(self, r):
            if r.tags.get('type') != 'site':
                return
            row = metadata(r, 'r', source['region'])
            row['members'] = [dict(type=m.type, ref=m.ref, role=m.role) for m in r.members]
            sites[row['id']] = row
    started = time.monotonic()
    emit('scan_sites', region=source['region'])
    with osmium.io.Reader(source['path'], osmium.osm.osm_entity_bits.RELATION) as reader:
        osmium.apply(reader, osmium.filter.KeyFilter('type'), Handler())
    result = dict(sites=sites, seconds=round(time.monotonic()-started, 2))
    save_cache(target, result)
    return result


def scan_members(source, needed, cache, emit):
    import osmium
    identity = hashlib.sha256(json.dumps({k: sorted(v) for k,v in needed.items()}, sort_keys=True).encode()).hexdigest()[:16]
    target = cache / (source['pbf_sha256'] + '-members-' + identity + '.json.gz')
    if target.exists():
        return read_cache(target)
    objects = {}
    class Handler(osmium.SimpleHandler):
        def node(self, n):
            if n.id in needed['n']:
                objects[osm_id('n', n.id)] = metadata(n, 'n', source['region'])
        def way(self, w):
            if w.id in needed['w']:
                objects[osm_id('w', w.id)] = metadata(w, 'w', source['region'])
        def relation(self, r):
            if r.id in needed['r']:
                objects[osm_id('r', r.id)] = metadata(r, 'r', source['region'])
    ids = set().union(*needed.values())
    started = time.monotonic()
    emit('scan_members', region=source['region'], needed=len(ids))
    if ids:
        with osmium.io.Reader(source['path']) as reader:
            osmium.apply(reader, osmium.filter.IdFilter(ids), Handler())
    result = dict(objects=objects, seconds=round(time.monotonic()-started, 2))
    save_cache(target, result)
    return result


def connect(root):
    sys.path.insert(0, str(root/'.deps'))
    import psycopg
    from psycopg.rows import dict_row
    config = json.loads((root/'database.json').read_text())
    if config['host'] not in ('127.0.0.1', 'localhost', '::1'):
        raise ValueError('Expected host-local database')
    return psycopg.connect(**config, row_factory=dict_row, autocommit=True)


def imports(conn):
    return conn.execute('''SELECT i.id::text AS import_id,i.region,i.pbf_sha256,
      i.pbf_timestamp,i.rows_count FROM osm.imports i JOIN osm.active_imports a
      ON a.import_id=i.id ORDER BY i.region''').fetchall()


def sources_for(root, rows):
    result = []
    for row in rows:
        paths = sorted((root/'raw').glob(row['region'] + '*.pbf'))
        if len(paths) != 1:
            raise ValueError('Expected exactly one raw PBF for ' + row['region'])
        result.append(dict(row, path=str(paths[0].resolve()), bytes=paths[0].stat().st_size))
    return result


def catalog_objects(conn, ids, emit=None):
    found = {}
    batch_size = 20000
    for offset in range(0, len(ids), batch_size):
        rows = conn.execute('''SELECT id,name,category,subcategory,tags,lon,lat,extract_region,
            pbf_timestamp FROM osm.current_poi WHERE id=ANY(%s)''', (ids[offset:offset+batch_size],)).fetchall()
        found.update({r['id']: r for r in rows})
        if emit:emit('catalog_join',matchedObjects=len(found),checkedObjects=min(offset+batch_size,len(ids)))
    return found


def copy_rows(conn, table, columns, rows):
    from psycopg import sql
    from psycopg.types.json import Jsonb
    with conn.cursor().copy(sql.SQL('COPY osm.{} ({}) FROM STDIN').format(
            sql.Identifier(table), sql.SQL(',').join(map(sql.Identifier, columns)))) as copy:
        for row in rows:
            copy.write_row([Jsonb(row[k]) if isinstance(row[k], dict) else row[k] for k in columns])


def backup_hierarchy(conn, root, build_id):
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    folder = root/'backups'/('site-hierarchy-'+stamp)
    folder.mkdir(parents=True, exist_ok=False)
    prior = conn.execute("SELECT to_regclass('osm.site_active') AS tbl").fetchone()['tbl']
    active = conn.execute('SELECT build_id FROM osm.site_active').fetchone() if prior else None
    if active:
        for table in ['site_builds','site_objects','site_members','site_edges','site_object_summary']:
            with gzip.open(folder/(table+'.jsonl.gz'), 'wt', encoding='utf8') as f:
                for row in conn.execute('SELECT to_jsonb(t) AS value FROM osm.'+table+' t WHERE build_id=%s', (active['build_id'],)):
                    f.write(json.dumps(row['value'], ensure_ascii=False, default=str)+'\n')
    atomic(folder/'receipt.json', dict(at=now(), previousBuild=active['build_id'] if active else None,
                                     nextBuild=build_id, originalPoiMutations=0))
    rollback = ("BEGIN; DELETE FROM osm.site_active; COMMIT;\n" if not active else
                "BEGIN; UPDATE osm.site_active SET build_id='"+active['build_id']+"' WHERE singleton; COMMIT;\n")
    (folder/'rollback.sql').write_text(rollback, encoding='utf8')
    return folder


def rebuild(root):
    if os.name != 'posix':
        raise RuntimeError('Run the full rebuild on the Linux database server')
    import fcntl
    from psycopg.types.json import Jsonb
    from extract import classify, KEYS
    from place_policy import display_name
    output = root/'audits'/'site-hierarchy'
    output.mkdir(parents=True, exist_ok=True)
    lock = (output/'run.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    started = time.monotonic()
    status = dict(algorithm=VERSION, startedAt=now(), pid=os.getpid(), status='running',
                  mapCalls=0, modelCalls=0)
    def emit(phase, **kw):
        status.update(phase=phase, updatedAt=now(), elapsedSeconds=round(time.monotonic()-started,2), **kw)
        atomic(output/'status.json', status)
        print(json.dumps(status, ensure_ascii=True, default=str), flush=True)
    cache = output/'cache'
    cache.mkdir(exist_ok=True)
    try:
        with connect(root) as conn:
            if not conn.execute('SELECT pg_try_advisory_lock(2026101202) AS locked').fetchone()['locked']:
                raise RuntimeError('A hierarchy rebuild is already running')
            conn.execute("SET statement_timeout='120s'")
            conn.execute("SET lock_timeout='5s'")
            rows = imports(conn)
            sources = sources_for(root, rows)
            if shutil.disk_usage(root).free < 4*1024**3:
                raise RuntimeError('Need 4 GiB free reserve')
            source_identity = json.dumps(rows, sort_keys=True, default=str)
            code = ''.join(digest(Path(__file__).with_name(n)) for n in
                           ['rebuild_sites.py','site_hierarchy.py','site_schema.sql'])
            code += ''.join(digest(Path(sys.modules[n].__file__)) for n in ['extract','place_policy'])
            build_id = hashlib.sha256((VERSION+source_identity+code).encode()).hexdigest()
            present = conn.execute("SELECT to_regclass('osm.site_builds') AS tbl").fetchone()['tbl']
            if present:
                done = conn.execute("SELECT summary FROM osm.site_builds WHERE build_id=%s AND status='complete'", (build_id,)).fetchone()
                if done:
                    active = conn.execute('SELECT build_id FROM osm.site_active').fetchone()
                    receipt=output/'receipt.json'
                    if not receipt.exists() or json.loads(receipt.read_text())['buildId']!=build_id:
                        atomic(receipt,dict(buildId=build_id,completedAt=now(),summary=done['summary'],
                                            examples=[],recoveredFromDatabase=True))
                    emit('already_complete', status='complete', buildId=build_id,
                         active=bool(active and active['build_id']==build_id), summary=done['summary'])
                    return
            sites = {}
            for i, source in enumerate(sources):
                emit('verify_source', region=source['region'], regionIndex=i+1, totalRegions=len(sources))
                if digest(Path(source['path'])) != source['pbf_sha256']:
                    raise ValueError('PBF checksum mismatch: '+source['region'])
                for site in scan_sites(source, cache, emit)['sites'].values():
                    choose(sites, site)
            needed = {k: set() for k in 'nwr'}
            for site in sites.values():
                for m in site['members']:
                    needed[m['type']].add(m['ref'])
            raw_objects = dict(sites)
            for i, source in enumerate(sources):
                emit('prepare_members',region=source['region'],regionIndex=i+1,totalRegions=len(sources))
                for obj in scan_members(source, needed, cache, emit)['objects'].values():
                    if obj['id'] not in sites:
                        choose(raw_objects, obj)
            ids = sorted(set(sites) | {osm_id(k,ref) for k,refs in needed.items() for ref in refs})
            emit('catalog_join', sourceSites=len(sites), referencedObjects=len(ids))
            catalog = catalog_objects(conn, ids, emit)
            objects = {}
            for obj_id in ids:
                raw = raw_objects.get(obj_id, {})
                original = catalog.get(obj_id)
                tags = original['tags'] if original else raw.get('tags', {})
                objects[obj_id] = dict(id=obj_id, build_id=build_id,
                    name=original['name'] if original else display_name(None, tags),
                    category=original['category'] if original else classify(tags),
                    subcategory=original['subcategory'] if original else next((tags[k] for k in KEYS if k in tags),None),
                    is_site=obj_id in sites,catalog_present=bool(original),tags=tags,
                    lon=original['lon'] if original else raw.get('lon'),
                    lat=original['lat'] if original else raw.get('lat'),
                    source_region=raw.get('region') or (original['extract_region'] if original else None),
                    source_version=raw.get('version'),
                    source_timestamp=raw.get('timestamp') or (original['pbf_timestamp'] if original else None),
                    availability='catalog' if original else 'source_object' if raw else 'missing_from_extracts')
            graph = build_graph(sites, objects)
            valid = [e for e in graph['edges'] if e['status']=='source_reported']
            if cyclic_pairs((e['parent_id'],e['child_id']) for e in valid):
                raise ValueError('Cycle check failed')
            assert all(objects[k]['category']==v['category'] and objects[k]['subcategory']==v['subcategory']
                       for k,v in catalog.items())
            category_edges = Counter(objects[e['child_id']]['category'] or 'unclassified' for e in valid)
            summary = dict(graph['counts'], existingCatalogObjects=len(catalog),
                supplementarySiteContainers=sum(k not in catalog for k in sites),
                unavailableMembers=sum(o['availability']=='missing_from_extracts' for o in objects.values()),
                childrenByCategory=dict(category_edges), activeImportRows=sum(r['rows_count'] for r in rows),
                activeRegions=len(rows), originalPoiMutations=0, categoryChanges=0,
                method='explicit_osm_site_only', sourceCoverage='all_active_imports',
                mapCalls=0,modelCalls=0,
                note='No site relationship recorded does not establish independence; spatial inclusion not inferred.')
            examples = []
            selected_categories = set()
            for e in valid:
                p,c=objects[e['parent_id']],objects[e['child_id']]
                if c['category'] not in selected_categories and c['catalog_present']:
                    examples.append(dict(parentId=p['id'],parentName=p['name'],childId=c['id'],
                                         childName=c['name'],category=c['category'],roles=e['roles']))
                    selected_categories.add(c['category'])
            emit('backup', buildId=build_id, summary=summary)
            backup=backup_hierarchy(conn,root,build_id)
            summary['backup']=str(backup)
            with conn.transaction():
                conn.execute('LOCK TABLE osm.active_imports IN SHARE MODE')
                if json.dumps(imports(conn),sort_keys=True,default=str)!=source_identity:
                    raise ValueError('Active imports changed during rebuild')
                conn.execute(Path(__file__).with_name('site_schema.sql').read_text(encoding='utf8'))
                conn.execute('INSERT INTO osm.site_builds(build_id,algorithm,sources,status,summary) VALUES(%s,%s,%s,%s,%s)',
                             (build_id,VERSION,Jsonb(json.loads(json.dumps(sources,default=str))),'loading',Jsonb(summary)))
                emit('load', backup=str(backup))
                copy_rows(conn,'site_objects',list(next(iter(objects.values())).keys()) if objects else
                          ['build_id','id','name','category','subcategory','is_site','catalog_present','tags','lon','lat','source_region','source_version','source_timestamp','availability'],objects.values())
                for key,table,columns in [
                    ('members','site_members',['build_id','parent_id','member_index','child_id','role','membership_kind']),
                    ('edges','site_edges',['build_id','parent_id','child_id','roles','status']),
                    ('summaries','site_object_summary',['build_id','id','parent_ids','child_count','children_by_category','membership_status'])]:
                    copy_rows(conn,table,columns,(dict(r,build_id=build_id) for r in graph[key]))
                for table,count in [('site_objects',len(objects)),('site_members',len(graph['members'])),
                                     ('site_edges',len(graph['edges'])),('site_object_summary',len(graph['summaries']))]:
                    got=conn.execute('SELECT count(*) AS n FROM osm.'+table+' WHERE build_id=%s',(build_id,)).fetchone()['n']
                    if got!=count:raise ValueError('Readback count mismatch: '+table)
                conn.execute("UPDATE osm.site_builds SET status='complete',completed_at=now() WHERE build_id=%s",(build_id,))
                conn.execute('INSERT INTO osm.site_active(singleton,build_id) VALUES(true,%s) ON CONFLICT(singleton) DO UPDATE SET build_id=excluded.build_id',(build_id,))
                exists=conn.execute("SELECT 1 FROM pg_roles WHERE rolname='seatraces_osm_reader'").fetchone()
                if exists:
                    conn.execute('GRANT SELECT ON osm.site_builds,osm.site_objects,osm.site_members,osm.site_edges,osm.site_object_summary,osm.site_active,osm.current_site_objects,osm.current_site_members,osm.current_site_edges,osm.current_site_summary,osm.current_poi_hierarchy TO seatraces_osm_reader')
            for table in ['site_objects','site_members','site_edges','site_object_summary']:
                conn.execute('ANALYZE osm.'+table)
            receipt=dict(buildId=build_id,completedAt=now(),summary=summary,examples=examples,
                         backup=str(backup),elapsedSeconds=round(time.monotonic()-started,2))
            atomic(output/'receipt.json',receipt)
            atomic(root/'audits'/('site-hierarchy-'+build_id[:16]+'.json'),receipt)
            emit('complete',status='complete',summary=summary,backup=str(backup))
    except BaseException as error:
        emit('failed',status='failed',error=type(error).__name__+': '+str(error))
        raise
    finally:
        lock.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=ROOT)
    parser.add_argument('--run',action='store_true')
    args=parser.parse_args()
    sys.path.insert(0,str(args.root/'.deps'))
    sys.path.insert(0,str(args.root/'.deps-site'))
    if args.run:
        rebuild(args.root.resolve())
    else:
        path=args.root/'audits/site-hierarchy/status.json'
        print(path.read_text(encoding='utf8') if path.exists() else '{"status":"not_started"}')


if __name__=='__main__':
    main()
