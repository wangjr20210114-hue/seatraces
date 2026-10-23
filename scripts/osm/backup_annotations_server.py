"""备份地点补充资料，并通过独立恢复核对结果。"""
from datetime import datetime,timezone
import hashlib,json,os,subprocess,sys,uuid
from pathlib import Path
ROOT=Path('/home/ubuntu/seatraces-osm');sys.path.insert(0,str(ROOT/'.deps'))
import psycopg
from psycopg import sql
os.umask(0o077)
config=json.loads((ROOT/'database.json').read_text())
backup=ROOT/'backups'/('annotations-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.dump')
docker=['sudo','-n','docker','exec','-i','seatraces-osm-db']
with backup.open('xb') as f:
    subprocess.run(docker+['pg_dump','-U','seatraces_osm','-d','seatraces_osm','--format=custom','--no-owner','--no-privileges','-t','osm.editorial_aliases','-t','osm.place_facts'],stdout=f,check=True)
target='osm_annotations_'+uuid.uuid4().hex[:12]
report={'scope':'New enrichment tables; use together with existing verified full OSM backup','path':str(backup.relative_to(ROOT)),
        'bytes':backup.stat().st_size,'sha256':hashlib.sha256(backup.read_bytes()).hexdigest(),'restored':False}
with psycopg.connect(**{**config,'dbname':'postgres'},autocommit=True) as admin:
    admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(target)))
    try:
        with psycopg.connect(**{**config,'dbname':target}) as c:c.execute('CREATE SCHEMA osm')
        with backup.open('rb') as f:subprocess.run(docker+['pg_restore','-U','seatraces_osm','-d',target,'--exit-on-error','--no-owner','--no-privileges'],stdin=f,check=True)
        with psycopg.connect(**config) as live,psycopg.connect(**{**config,'dbname':target}) as restored:
            for table,order in [('editorial_aliases','place_id,alias'),('place_facts','id')]:
                query='SELECT * FROM osm.'+table+' ORDER BY '+order
                expected=live.execute(query).fetchall();actual=restored.execute(query).fetchall()
                assert expected==actual,'Restored rows differ'
                report[table]=len(actual)
        report['restored']=True
    finally:
        assert target.startswith('osm_annotations_') and len(target)==28
        admin.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(target)))
report['at']=datetime.now(timezone.utc).isoformat()
(ROOT/'annotation-backup.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
