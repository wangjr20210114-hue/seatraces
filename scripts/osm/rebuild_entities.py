"""根据名称和几何资料重建统一景点实体。"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import time

from rebuild_sites import connect, atomic, now, digest, imports
from entity_identity import VERSION, SCENIC, identity_keys, evidence, group_matches, aliases_for, normalize

ROOT = Path('/home/ubuntu/seatraces-osm')


def run(root=ROOT):
    import fcntl
    from psycopg.types.json import Jsonb
    out = root/'audits/entity-dedup'
    out.mkdir(parents=True, exist_ok=True)
    lock = (out/'run.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    started = time.monotonic()
    state = dict(status='running', algorithm=VERSION, startedAt=now(), pid=os.getpid(), mapCalls=0, modelCalls=0)
    def emit(phase, **kw):
        state.update(phase=phase, updatedAt=now(), elapsedSeconds=round(time.monotonic()-started, 2), **kw)
        atomic(out/'status.json', state)
        print(json.dumps(state, ensure_ascii=True), flush=True)
    try:
        with connect(root) as conn:
            if not conn.execute('SELECT pg_try_advisory_lock(2026101301) AS ok').fetchone()['ok']:
                raise RuntimeError('Identity rebuild already running')
            conn.execute("SET statement_timeout='40min'")
            conn.execute("SET lock_timeout='5s'")
            conn.execute("SET work_mem='32MB'")
            conn.execute('SET max_parallel_workers_per_gather=0')
            conn.execute(Path(__file__).with_name('entity_schema.sql').read_text())
            active = conn.execute('SELECT b.* FROM osm.containment_active a JOIN osm.containment_builds b USING(build_id)').fetchone()
            if not active or active['status'] != 'complete':
                raise ValueError('A complete containment build is required')
            cb = active['build_id']
            import_snapshot=imports(conn)
            changed = conn.execute('''WITH snapshot AS (SELECT * FROM osm.containment_places WHERE build_id=%s)
                SELECT count(*) AS n FROM snapshot c FULL JOIN osm.current_poi p ON p.id=c.id
                WHERE p.id IS NULL OR c.id IS NULL OR c.source_timestamp IS DISTINCT FROM p.pbf_timestamp
                OR c.source_region<>p.extract_region''', (cb,)).fetchone()['n']
            if changed:
                raise ValueError('Containment/source snapshot changed; rebuild containment first')
            names = ['entity_identity.py','entity_reviewed.json','entity_schema.sql','rebuild_entities.py','entity_catalog.py']
            build = hashlib.sha256((cb + ''.join(digest(Path(__file__).with_name(n)) for n in names)).encode()).hexdigest()
            existing = conn.execute('SELECT status,summary FROM osm.entity_builds WHERE build_id=%s', (build,)).fetchone()
            if existing and existing['status']=='complete':
                if conn.execute('SELECT build_id FROM osm.entity_active').fetchone() != {'build_id':build}:
                    raise ValueError('Complete version is inactive; no implicit reactivation')
                emit('already_complete', status='complete', buildId=build, summary=existing['summary'])
                return
            if shutil.disk_usage(root).free < 4*1024**3:
                raise RuntimeError('Need at least 4 GiB free for temporary identity indexes')
            if existing:
                for table in ['entity_summary','entity_edges','entity_aliases','entity_members','entity_builds']:
                    conn.execute('DELETE FROM osm.'+table+' WHERE build_id=%s',(build,))
            conn.execute('INSERT INTO osm.entity_builds(build_id,containment_build,algorithm,status) VALUES(%s,%s,%s,%s)',(build,cb,VERSION,'building'))
            emit('prepare_identity_candidates', buildId=build, containmentBuild=cb)
            conn.execute('''CREATE TEMP TABLE identity_work AS SELECT p.id,p.name,p.aliases,p.category,p.subcategory,
                jsonb_strip_nulls(jsonb_build_object('wikidata',p.tags->'wikidata','wikipedia',p.tags->'wikipedia')) AS tags,
                c.geom,c.area_m2,ST_Dimension(c.geom) AS dimension,ARRAY[]::text[] AS identity_keys
                FROM osm.current_poi p JOIN osm.containment_places c ON c.id=p.id AND c.build_id=%s
                WHERE p.selectable AND p.category=ANY(%s) AND c.geom IS NOT NULL AND ST_Dimension(c.geom) IN (0,2)''',(cb,list(SCENIC)))
            conn.execute('ALTER TABLE identity_work ADD PRIMARY KEY(id)')
            conn.execute('CREATE TEMP TABLE identity_keys_load(id text, keys text[])')
            after=''; processed=0
            while True:
                rows=conn.execute('SELECT id,name,aliases,tags,category FROM identity_work WHERE id>%s ORDER BY id LIMIT 5000',(after,)).fetchall()
                if not rows: break
                with conn.transaction():
                    conn.execute('TRUNCATE identity_keys_load')
                    with conn.cursor().copy('COPY identity_keys_load FROM STDIN') as copy:
                        for row in rows: copy.write_row([row['id'], identity_keys(row)])
                    conn.execute('UPDATE identity_work w SET identity_keys=k.keys FROM identity_keys_load k WHERE k.id=w.id')
                after=rows[-1]['id']; processed+=len(rows)
                if processed%50000==0: emit('normalize_identity_keys', processedScenicPlaces=processed)
            conn.execute('CREATE INDEX ON identity_work USING gin(identity_keys)')
            conn.execute('CREATE INDEX ON identity_work USING gist(geom)')
            conn.execute('ANALYZE identity_work')
            emit('match_identities', processedScenicPlaces=processed)
            query='''SELECT to_jsonb(a)-'geom'-'identity_keys' AS a,to_jsonb(b)-'geom'-'identity_keys' AS b,
                CASE WHEN a.dimension=0 AND b.dimension=0 THEN 'point_point'
                     WHEN a.dimension=2 AND b.dimension=2 THEN 'area_area' ELSE 'point_area' END AS kind,
                CASE WHEN a.dimension=0 AND b.dimension=2 THEN ST_Covers(b.geom,a.geom)
                     WHEN a.dimension=2 AND b.dimension=0 THEN ST_Covers(a.geom,b.geom) ELSE false END AS covered,
                CASE WHEN a.dimension=2 AND b.dimension=2 THEN ST_Area(ST_Intersection(a.geom,b.geom)::geography)/NULLIF(GREATEST(a.area_m2,b.area_m2),0) ELSE 0 END AS overlap,
                CASE WHEN a.dimension=0 AND b.dimension=0 THEN ST_Distance(a.geom::geography,b.geom::geography) ELSE 0 END AS distance
                FROM identity_work a JOIN identity_work b ON b.id>a.id AND b.identity_keys && a.identity_keys
                AND b.geom && ST_Expand(a.geom,0.01)'''
            records={}; matches=[]; examined=0
            with conn.transaction():
                with conn.cursor(name='identity_candidate_stream') as cur:
                    cur.execute(query)
                    for row in cur:
                        a,b=row.pop('a'),row.pop('b'); examined+=1
                        why=evidence(a,b,row)
                        if why:
                            records[a['id']]=a; records[b['id']]=b; matches.append((a['id'],b['id'],why))
                        if examined%10000==0: emit('match_identities', candidatePairs=examined, acceptedPairs=len(matches))
            for reviewed in json.loads(Path(__file__).with_name('entity_reviewed.json').read_text(encoding='utf8')):
                pair=conn.execute('''SELECT to_jsonb(a)-'geom'-'identity_keys' AS a,to_jsonb(b)-'geom'-'identity_keys' AS b,
                    a.dimension=2 AND b.dimension=0 AND ST_Covers(a.geom,b.geom) AS covered
                    FROM identity_work a JOIN identity_work b ON b.id=%s WHERE a.id=%s''',
                    (reviewed['sourceId'],reviewed['canonicalId'])).fetchone()
                if not pair or not pair['covered'] or pair['a']['name']!=reviewed['canonicalName'] or pair['b']['name']!=reviewed['sourceName']:
                    raise ValueError('Reviewed identity no longer matches source: '+reviewed['canonicalId'])
                for obj in [pair['a'],pair['b']]: records[obj['id']]=obj
                matches.append((pair['a']['id'],pair['b']['id'],reviewed))
            groups=group_matches(records,matches)
            with conn.transaction():
                with conn.cursor().copy('COPY osm.entity_members(build_id,source_id,canonical_id,evidence) FROM STDIN') as copy:
                    for main,members in groups:
                        for member,why in members: copy.write_row([build,member,main,Jsonb(why)])
                with conn.cursor().copy('COPY osm.entity_aliases(build_id,canonical_id,alias,normalized,source_id) FROM STDIN') as copy:
                    for main,members in groups:
                        for alias,source in aliases_for([records[m] for m,_ in members],records[main]):
                            copy.write_row([build,main,alias,normalize(alias),source])
            conn.execute('ANALYZE osm.entity_members')
            emit('relink_hierarchy', mergedEntities=len(groups), sourceObjects=sum(len(m) for _,m in groups))
            conn.execute('''WITH RECURSIVE chain AS (
                SELECT e.child_id,e.parent_id,1 AS hop FROM osm.containment_edges e
                LEFT JOIN osm.entity_members m ON m.build_id=%s AND m.source_id=e.child_id
                WHERE e.build_id=%s AND (m.source_id IS NULL OR m.source_id=m.canonical_id)
                UNION ALL SELECT c.child_id,e.parent_id,c.hop+1 FROM chain c
                JOIN osm.containment_edges e ON e.build_id=%s AND e.child_id=c.parent_id WHERE c.hop<7
              ), candidates AS (
                SELECT DISTINCT ON(c.child_id) c.child_id,p.id AS parent_id FROM chain c
                LEFT JOIN osm.entity_members m ON m.build_id=%s AND m.source_id=c.parent_id
                JOIN osm.containment_places p ON p.build_id=%s AND p.id=COALESCE(m.canonical_id,c.parent_id)
                JOIN osm.containment_places ch ON ch.build_id=p.build_id AND ch.id=c.child_id
                WHERE p.id<>ch.id AND p.is_container AND p.area_m2>ch.area_m2 AND ST_Covers(p.geom,ch.geom)
                ORDER BY c.child_id,p.area_m2,p.id
              ) INSERT INTO osm.entity_edges(build_id,child_id,parent_id) SELECT %s,child_id,parent_id FROM candidates''',
                (build,cb,cb,build,cb,build))
            conn.execute('ANALYZE osm.entity_edges')
            conn.execute('''WITH RECURSIVE tree AS (
                SELECT e.child_id,e.parent_id AS root_id,2 AS depth FROM osm.entity_edges e WHERE e.build_id=%s
                AND NOT EXISTS(SELECT 1 FROM osm.entity_edges p WHERE p.build_id=e.build_id AND p.child_id=e.parent_id)
                UNION ALL SELECT e.child_id,t.root_id,t.depth+1 FROM tree t JOIN osm.entity_edges e
                ON e.build_id=%s AND e.parent_id=t.child_id WHERE t.depth<8
              ) UPDATE osm.entity_edges e SET root_id=t.root_id,depth=t.depth FROM tree t WHERE e.build_id=%s AND e.child_id=t.child_id''',(build,build,build))
            conn.execute('''INSERT INTO osm.entity_summary SELECT %s,parent_id,sum(n)::integer,jsonb_object_agg(category,n)
                FROM (SELECT e.parent_id,p.category,count(*) AS n FROM osm.entity_edges e JOIN osm.containment_places p
                ON p.build_id=%s AND p.id=e.child_id WHERE e.build_id=%s GROUP BY e.parent_id,p.category) x GROUP BY parent_id''',(build,cb,build))
            emit('validate')
            invalid=conn.execute('''SELECT count(*) AS n FROM osm.entity_edges e
                JOIN osm.containment_places c ON c.build_id=%s AND c.id=e.child_id
                JOIN osm.containment_places p ON p.build_id=c.build_id AND p.id=e.parent_id
                LEFT JOIN osm.entity_edges pe ON pe.build_id=e.build_id AND pe.child_id=e.parent_id
                LEFT JOIN osm.entity_members cm ON cm.build_id=e.build_id AND cm.source_id=e.child_id
                LEFT JOIN osm.entity_members pm ON pm.build_id=e.build_id AND pm.source_id=e.parent_id
                WHERE e.build_id=%s AND (e.depth IS NULL OR e.root_id IS NULL OR e.depth<>COALESCE(pe.depth,1)+1
                OR NOT ST_Covers(p.geom,c.geom) OR p.area_m2<=c.area_m2
                OR cm.canonical_id<>e.child_id OR pm.canonical_id<>e.parent_id)''',(cb,build)).fetchone()['n']
            if invalid: raise ValueError('Invalid canonical hierarchy: '+str(invalid))
            nested=conn.execute('''SELECT count(*) AS n FROM osm.entity_members m JOIN osm.entity_members p
                ON p.build_id=m.build_id AND p.source_id=m.canonical_id
                WHERE m.build_id=%s AND p.source_id<>p.canonical_id''',(build,)).fetchone()['n']
            if nested: raise ValueError('Canonical ID redirects must be one hop')
            for child,parent in [('osm:way/638449347','osm:relation/9511883')]:
                if conn.execute('SELECT parent_id FROM osm.entity_edges WHERE build_id=%s AND child_id=%s',(build,child)).fetchone()!={'parent_id':parent}:
                    raise ValueError('Real Taihe child relation was lost')
            stats=conn.execute('SELECT count(*) AS links,COALESCE(max(depth),1) AS depth FROM osm.entity_edges WHERE build_id=%s',(build,)).fetchone()
            removed=sum(len(m)-1 for _,m in groups)
            summary=dict(originalPlaces=active['summary']['totalPlaces'],canonicalPlaces=active['summary']['totalPlaces']-removed,
                mergedGroups=len(groups),duplicateRepresentations=removed,scenicObjectsCompared=processed,candidatePairs=examined,
                linkedChildren=stats['links'],maxDepth=stats['depth'],depthLimit=8,mapCalls=0,modelCalls=0,originalPoiMutations=0,
                policy='explicit_identity_plus_geometry; aliases_and_legacy_ids_resolve_to_canonical; no_fuzzy_or_transitive_merge')
            previous=conn.execute('SELECT build_id FROM osm.entity_active').fetchone()
            backup=root/'backups'/('entity-'+now().replace(':','').replace('+','-'))
            backup.mkdir(parents=True)
            atomic(backup/'receipt.json',dict(previousBuild=previous['build_id'] if previous else None,buildId=build))
            rollback='DELETE FROM osm.entity_active;' if not previous else "UPDATE osm.entity_active SET build_id='"+previous['build_id']+"' WHERE singleton;"
            (backup/'rollback.sql').write_text('BEGIN; '+rollback+' COMMIT;\n')
            with conn.transaction():
                conn.execute('LOCK TABLE osm.containment_active,osm.active_imports IN SHARE MODE')
                if conn.execute('SELECT build_id FROM osm.containment_active').fetchone()['build_id']!=cb:
                    raise ValueError('Containment version changed')
                if imports(conn)!=import_snapshot:raise ValueError('Source imports changed during identity rebuild')
                conn.execute("UPDATE osm.entity_builds SET status='complete',completed_at=now(),summary=%s WHERE build_id=%s",(Jsonb(summary),build))
                conn.execute('INSERT INTO osm.entity_active VALUES(true,%s) ON CONFLICT(singleton) DO UPDATE SET build_id=excluded.build_id',(build,))
                conn.execute('GRANT SELECT ON osm.entity_builds,osm.entity_members,osm.entity_aliases,osm.entity_edges,osm.entity_summary,osm.entity_active TO seatraces_osm_reader')
            for table in ['entity_members','entity_aliases','entity_edges','entity_summary']: conn.execute('ANALYZE osm.'+table)
            atomic(out/'receipt.json',dict(buildId=build,containmentBuild=cb,summary=summary,backup=str(backup),completedAt=now()))
            emit('complete',status='complete',summary=summary)
    except BaseException as exc:
        emit('failed',status='failed',error=type(exc).__name__+': '+str(exc))
        raise
    finally:
        lock.close()


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run',action='store_true')
    if not parser.parse_args().run: parser.error('Explicit --run required')
    run()
