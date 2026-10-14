"""Create a logical backup and optionally restore it into a disposable database."""
import argparse
from datetime import datetime,timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

ROOT=Path('/home/ubuntu/seatraces-osm')
sys.path.insert(0,str(ROOT/'.deps'))
import psycopg
from psycopg import sql
from download import digest

parser=argparse.ArgumentParser()
parser.add_argument('--verify-restore',action='store_true')
args=parser.parse_args()
os.umask(0o077)
config=json.loads((ROOT/'database.json').read_text())
folder=ROOT/'backups'
folder.mkdir(exist_ok=True)
name=datetime.now(timezone.utc).strftime('osm-%Y%m%dT%H%M%SZ')
backup=folder/(name+'.dump')
partial=folder/(name+'.dump.partial')
docker=['sudo','-n','docker','exec','-i','seatraces-osm-db']
with partial.open('xb') as target:
    subprocess.run(docker+['pg_dump','-U','seatraces_osm','-d','seatraces_osm','--format=custom','--no-owner','--no-privileges'],stdout=target,check=True)
partial.replace(backup)
report={'path':backup.name,'bytes':backup.stat().st_size,'sha256':digest(backup,'sha256'),'restore_verified':False}
if args.verify_restore:
    target_db='osm_restore_'+uuid.uuid4().hex[:12]
    with psycopg.connect(**{**config,'dbname':'postgres'},autocommit=True) as admin:
        admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(target_db)))
        try:
            with backup.open('rb') as source:
                subprocess.run(docker+['pg_restore','-U','seatraces_osm','-d',target_db,'--exit-on-error','--no-owner','--no-privileges'],stdin=source,check=True)
            with psycopg.connect(**config) as live,psycopg.connect(**{**config,'dbname':target_db}) as restored:
                check='SELECT i.region,i.pbf_sha256,count(p.id) FROM osm.imports i LEFT JOIN osm.poi p ON p.import_id=i.id GROUP BY i.region,i.pbf_sha256 ORDER BY i.region,i.pbf_sha256'
                expected=live.execute(check).fetchall()
                actual=restored.execute(check).fetchall()
                if expected!=actual: raise RuntimeError('Restored row counts or snapshot hashes differ')
                active='SELECT region,import_id FROM osm.active_imports ORDER BY region'
                if live.execute(active).fetchall()!=restored.execute(active).fetchall(): raise RuntimeError('Restored active versions differ')
                places="SELECT id,name,lon,lat FROM osm.search_places('外滩',result_limit=>5) ORDER BY id"
                if live.execute(places).fetchall()!=restored.execute(places).fetchall(): raise RuntimeError('Restored search result differs')
                spatial="SELECT count(*) FROM pg_indexes WHERE schemaname='osm' AND indexname='osm_poi_location'"
                if restored.execute(spatial).fetchone()[0]!=1: raise RuntimeError('Spatial index missing after restore')
                report.update(restore_verified=True,verified_imports=actual)
        finally:
            if not target_db.startswith('osm_restore_') or len(target_db)!=24: raise RuntimeError('Unexpected restore database name')
            admin.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(target_db)))
(folder/(name+'.json')).write_text(json.dumps(report,indent=2))
print(json.dumps(report))
