"""Rebuild geometric parents for all current OSM places on the database host.

Uses existing regional PBFs; zero map or LLM calls. New immutable build tables
are published only after validation. Root=1; maximum depth=8. Category unchanged.
"""
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
import subprocess
import time

from containment_hierarchy import VERSION, MAX_DEPTH, SCENIC
from containment_geometry import extract_geometries
from rebuild_sites import connect, imports, sources_for, digest, atomic, now

ROOT=Path('/home/ubuntu/seatraces-osm')
FILES=['rebuild_containment.py','containment_hierarchy.py','containment_geometry.py','containment_schema.sql']


def load_geometry(conn, path, build_id, region, emit):
    conn.execute('CREATE TEMP TABLE IF NOT EXISTS containment_load(id text PRIMARY KEY,wkb text,version bigint)')
    total=0
    with gzip.open(path,'rt',encoding='utf8') as stream:
        while True:
            batch=[]
            for _ in range(10000):
                line=stream.readline()
                if not line:break
                batch.append(json.loads(line))
            if not batch:break
            with conn.transaction():
                conn.execute('TRUNCATE containment_load')
                with conn.cursor().copy('COPY containment_load(id,wkb,version) FROM STDIN') as copy:
                    for row in batch:copy.write_row([row['id'],row['wkb'],row['version']])
                conn.execute('''UPDATE osm.containment_places p SET
                    geom=ST_GeomFromWKB(decode(l.wkb,'hex'),4326),source_version=l.version,
                    geometry_state='full_geometry'
                    FROM containment_load l WHERE p.build_id=%s AND p.id=l.id AND p.source_region=%s''',(build_id,region))
            total+=len(batch)
            if total%100000==0:emit('load_geometry',region=region,loadedGeometries=total)
    return total


def rebuild(root):
    if os.name!='posix':raise RuntimeError('Run on the Linux database host')
    import fcntl
    from psycopg.types.json import Jsonb
    out=root/'audits/containment-hierarchy'
    out.mkdir(parents=True,exist_ok=True)
    lock=(out/'run.lock').open('a')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    started=time.monotonic()
    status=dict(algorithm=VERSION,status='running',startedAt=now(),pid=os.getpid(),mapCalls=0,modelCalls=0,maxDepth=MAX_DEPTH)
    def emit(phase,**extra):
        status.update(phase=phase,updatedAt=now(),elapsedSeconds=round(time.monotonic()-started,2),**extra)
        atomic(out/'status.json',status)
        print(json.dumps(status,ensure_ascii=True,default=str),flush=True)
    def reserve():
        if shutil.disk_usage(root).free<3*1024**3:raise RuntimeError('At least 3 GiB free reserve required')
    try:
        with connect(root) as conn:
            if not conn.execute('SELECT pg_try_advisory_lock(2026101203) AS locked').fetchone()['locked']:
                raise RuntimeError('Another containment build is running')
            conn.execute("SET statement_timeout='30min'")
            conn.execute("SET lock_timeout='5s'")
            conn.execute("SET work_mem='32MB'")
            conn.execute('SET max_parallel_workers_per_gather=0')
            rows=imports(conn);sources=sources_for(root,rows)
            identity=json.dumps(rows,sort_keys=True,default=str)
            code=''.join(digest(Path(__file__).with_name(f)) for f in FILES)
            import extract, place_policy
            code+=digest(Path(extract.__file__))+digest(Path(place_policy.__file__))
            fingerprint=hashlib.sha256((VERSION+code).encode()).hexdigest()
            build=hashlib.sha256((fingerprint+identity).encode()).hexdigest()
            conn.execute(Path(__file__).with_name('containment_schema.sql').read_text(encoding='utf8'))
            existing=conn.execute('SELECT status,summary FROM osm.containment_builds WHERE build_id=%s',(build,)).fetchone()
            if existing and existing['status']=='complete':
                active=conn.execute('SELECT build_id FROM osm.containment_active').fetchone()
                if not active or active['build_id']!=build:
                    raise RuntimeError('Completed build exists but is inactive; explicit rollback/reactivation required')
                atomic(out/'receipt.json',dict(buildId=build,completedAt=now(),summary=existing['summary'],reused=True))
                emit('already_complete',status='complete',buildId=build,summary=existing['summary'])
                return
            if shutil.disk_usage(root).free<8*1024**3:raise RuntimeError('Need 8 GiB free before the first complete geometry build')
            cache=out/'cache';cache.mkdir(exist_ok=True)
            for source in sources:
                emit('verify_source',region=source['region'],buildId=build)
                if digest(Path(source['path']))!=source['pbf_sha256']:raise ValueError('PBF hash mismatch: '+source['region'])
            if existing:
                # Only an unpublished failed draft can be restarted. Successful builds are immutable.
                active=conn.execute('SELECT build_id FROM osm.containment_active').fetchone()
                if active and active['build_id']==build:raise ValueError('Refusing to replace the active build')
                with conn.transaction():
                    for table in ['containment_summary','containment_edges','containment_places','containment_builds']:
                        conn.execute('DELETE FROM osm.'+table+' WHERE build_id=%s',(build,))
            conn.execute('INSERT INTO osm.containment_builds(build_id,algorithm,sources,status) VALUES(%s,%s,%s,%s)',
                         (build,VERSION,Jsonb(json.loads(json.dumps(sources,default=str))),'building'))
            emit('snapshot_catalog')
            conn.execute('''INSERT INTO osm.containment_places
                (build_id,id,name,category,subcategory,lon,lat,source_region,source_timestamp,geometry_state,geom,container_eligible)
                SELECT %s,id,name,category,subcategory,lon,lat,extract_region,pbf_timestamp,
                  CASE WHEN osm_type='node' THEN 'mapped_point' ELSE 'unavailable_geometry' END,
                  CASE WHEN osm_type='node' THEN ST_SetSRID(ST_MakePoint(lon,lat),4326) END,
                  category=ANY(%s) AND NOT(tags ? 'admin_level')
                    AND COALESCE(tags->>'boundary','') NOT IN ('administrative','political')
                    AND COALESCE(tags->>'area','')<>'no'
                FROM osm.current_poi''',(build,list(SCENIC)))
            total=conn.execute('SELECT count(*) AS n FROM osm.containment_places WHERE build_id=%s',(build,)).fetchone()['n']
            if total==0:raise ValueError('Current catalog is empty; refusing to publish an empty hierarchy')
            extraction=[]
            for index,source in enumerate(sources):
                reserve();emit('extract_geometry',region=source['region'],regionIndex=index+1,totalRegions=len(sources),totalPlaces=total)
                # Release osmium's disk-backed node cache after every country,
                # even if a native library retains handles until process exit.
                source_file=cache/(source['region']+'-source.json')
                atomic(source_file,source)
                subprocess.run([sys.executable,str(Path(__file__).with_name('containment_geometry.py')),
                    '--source',str(source_file),'--cache',str(cache),'--fingerprint',fingerprint],check=True)
                path,report=extract_geometries(source,cache,fingerprint,emit)
                load_geometry(conn,path,build,source['region'],emit)
                extraction.append(dict(region=source['region'],**report))
            emit('prepare_spatial_index')
            # Geometry validity was checked during extraction; point rows come from constrained catalog coordinates.
            conn.execute('''UPDATE osm.containment_places SET
                area_m2=ST_Area(geom::geography),is_container=container_eligible
                WHERE build_id=%s AND ST_Dimension(geom)=2''',(build,))
            conn.execute('ANALYZE osm.containment_places')
            reserve()
            after='';processed=0
            conn.execute('CREATE TEMP TABLE containment_child_batch(id text PRIMARY KEY)')
            while True:
                with conn.transaction():
                    conn.execute('TRUNCATE containment_child_batch')
                    conn.execute('''INSERT INTO containment_child_batch SELECT id FROM osm.containment_places
                       WHERE build_id=%s AND id>%s ORDER BY id LIMIT 20000''',(build,after))
                    part=conn.execute('SELECT count(*) AS n,max(id) AS last FROM containment_child_batch').fetchone()
                    if not part['n']:break
                    conn.execute('''INSERT INTO osm.containment_edges(build_id,child_id,parent_id,natural_parent_id)
                      SELECT c.build_id,c.id,parent.id,parent.id
                      FROM containment_child_batch b JOIN osm.containment_places c ON c.id=b.id AND c.build_id=%s
                      CROSS JOIN LATERAL (
                        SELECT p.id FROM osm.containment_places p
                        WHERE p.build_id=c.build_id AND p.is_container AND p.id<>c.id
                          AND p.area_m2>c.area_m2 AND p.geom && c.geom AND ST_Covers(p.geom,c.geom)
                        ORDER BY p.area_m2,p.id LIMIT 1
                      ) parent WHERE c.geom IS NOT NULL''',(build,))
                processed+=part['n'];after=part['last']
                emit('assign_parents',processedPlaces=processed,totalPlaces=total)
                reserve()
            emit('cap_depth')
            conn.execute('ANALYZE osm.containment_edges')
            conn.execute('''WITH RECURSIVE tree AS (
              SELECT e.child_id,e.parent_id,e.parent_id AS root_id,2 AS natural_depth,2 AS depth,NULL::text AS level7
              FROM osm.containment_edges e WHERE e.build_id=%s AND NOT EXISTS
                (SELECT 1 FROM osm.containment_edges p WHERE p.build_id=e.build_id AND p.child_id=e.parent_id)
              UNION ALL
              SELECT e.child_id,CASE WHEN t.natural_depth>=8 THEN t.level7 ELSE e.parent_id END,
                t.root_id,t.natural_depth+1,LEAST(t.depth+1,8),
                CASE WHEN t.natural_depth+1=7 THEN e.child_id ELSE t.level7 END
              FROM tree t JOIN osm.containment_edges e ON e.parent_id=t.child_id AND e.build_id=%s
            ) UPDATE osm.containment_edges e SET parent_id=t.parent_id,root_id=t.root_id,
              natural_depth=t.natural_depth,depth=t.depth,depth_limited=t.natural_depth>8
              FROM tree t WHERE e.build_id=%s AND e.child_id=t.child_id''',(build,build,build))
            conn.execute('''INSERT INTO osm.containment_summary(build_id,id,child_count,children_by_category)
              SELECT %s,parent_id,sum(n)::integer,jsonb_object_agg(category,n)
              FROM (SELECT e.parent_id,p.category,count(*) AS n FROM osm.containment_edges e
                JOIN osm.containment_places p ON p.build_id=e.build_id AND p.id=e.child_id
                WHERE e.build_id=%s GROUP BY e.parent_id,p.category) c GROUP BY parent_id''',(build,build))
            emit('validate')
            # Strictly increasing polygon area guarantees acyclicity; validate all published edges, including compressed ones.
            invalid=conn.execute('''SELECT count(*) AS n FROM osm.containment_edges e
              JOIN osm.containment_places c ON c.build_id=e.build_id AND c.id=e.child_id
              JOIN osm.containment_places p ON p.build_id=e.build_id AND p.id=e.parent_id
              LEFT JOIN osm.containment_edges pe ON pe.build_id=e.build_id AND pe.child_id=e.parent_id
              WHERE e.build_id=%s AND (e.depth IS NULL OR e.root_id IS NULL OR e.depth<>COALESCE(pe.depth,1)+1
                OR NOT ST_Covers(p.geom,c.geom) OR p.area_m2<=c.area_m2)''',(build,)).fetchone()['n']
            if invalid:raise ValueError('Invalid containment or depth edges: '+str(invalid))
            count=conn.execute('''SELECT count(*) AS children,COALESCE(max(depth),1) AS max_depth,
              COALESCE(max(natural_depth),1) AS natural_max_depth,count(*) FILTER(WHERE depth_limited) AS compressed
              FROM osm.containment_edges WHERE build_id=%s''',(build,)).fetchone()
            states=conn.execute('SELECT geometry_state,count(*) AS n FROM osm.containment_places WHERE build_id=%s GROUP BY geometry_state',(build,)).fetchall()
            parents=conn.execute('SELECT count(*) AS n FROM osm.containment_places WHERE build_id=%s AND is_container',(build,)).fetchone()['n']
            category_changes=conn.execute('''SELECT count(*) AS n FROM osm.containment_places p JOIN osm.current_poi c ON p.id=c.id
              WHERE p.build_id=%s AND (p.category<>c.category OR p.subcategory IS DISTINCT FROM c.subcategory)''',(build,)).fetchone()['n']
            if category_changes:raise ValueError('Catalog categories changed during rebuild')
            summary=dict(totalPlaces=total,linkedChildren=count['children'],parentPolygons=parents,maxDepth=count['max_depth'],
              naturalMaxDepth=count['natural_max_depth'],depthCompressed=count['compressed'],
              geometryStates={s['geometry_state']:s['n'] for s in states},regions=len(sources),extraction=extraction,
              method='full_geometry_covers_smallest_scenic_area',rootLevel=1,depthLimit=8,
              boundaryContactAllowed=True,equalPolygonsExcluded=True,originalPoiMutations=0,categoryChanges=0,
              mapCalls=0,modelCalls=0,scope='all_active_catalog_categories',
              note='Geometric product hierarchy; no ownership, common ticket or opening-rule inheritance implied.')
            previous=conn.execute('SELECT build_id FROM osm.containment_active').fetchone()
            backup=root/'backups'/('containment-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
            backup.mkdir(parents=True,exist_ok=False)
            atomic(backup/'receipt.json',dict(previousBuild=previous['build_id'] if previous else None,nextBuild=build,originalPoiMutations=0))
            rollback="DELETE FROM osm.containment_active;" if not previous else "UPDATE osm.containment_active SET build_id='"+previous['build_id']+"' WHERE singleton;"
            (backup/'rollback.sql').write_text('BEGIN; '+rollback+' COMMIT;\n',encoding='utf8')
            with conn.transaction():
                conn.execute('LOCK TABLE osm.active_imports IN SHARE MODE')
                if json.dumps(imports(conn),sort_keys=True,default=str)!=identity:raise ValueError('Source imports changed')
                conn.execute("UPDATE osm.containment_builds SET status='complete',completed_at=now(),summary=%s WHERE build_id=%s",(Jsonb(summary),build))
                conn.execute('INSERT INTO osm.containment_active(singleton,build_id) VALUES(true,%s) ON CONFLICT(singleton) DO UPDATE SET build_id=excluded.build_id',(build,))
                if conn.execute("SELECT 1 FROM pg_roles WHERE rolname='seatraces_osm_reader'").fetchone():
                    conn.execute('GRANT SELECT ON osm.containment_builds,osm.containment_places,osm.containment_edges,osm.containment_summary,osm.containment_active TO seatraces_osm_reader')
            for table in ['containment_builds','containment_active','containment_places','containment_edges','containment_summary']:
                conn.execute('ANALYZE osm.'+table)
            receipt=dict(buildId=build,completedAt=now(),summary=summary,backup=str(backup),elapsedSeconds=round(time.monotonic()-started,2))
            atomic(out/'receipt.json',receipt)
            emit('complete',status='complete',summary=summary,backup=str(backup))
    except BaseException as error:
        emit('failed',status='failed',error=type(error).__name__+': '+str(error))
        raise
    finally:
        lock.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=ROOT)
    parser.add_argument('--run',action='store_true')
    args=parser.parse_args()
    if not args.run:parser.error('Pass --run on the database host')
    sys.path[:0]=[str(args.root/'.deps-site'),str(args.root/'.deps'),str(args.root/'scripts/osm')]
    rebuild(args.root)
