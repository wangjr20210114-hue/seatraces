"""检查原始文件、地点快照、检索和服务状态。"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path('/home/ubuntu/seatraces-osm')
sys.path.insert(0, str(ROOT / '.deps'))
import psycopg
from psycopg.rows import dict_row
from download import digest

parser = argparse.ArgumentParser()
parser.add_argument('--raw', action='store_true')
args = parser.parse_args()
report = {'verified_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
if (ROOT/'finalization.json').exists():
    report['pilot_cleanup_record']='finalization.json'
if args.raw:
    report['raw'] = []
    for manifest_path in sorted((ROOT / 'raw').glob('*-manifest.json')):
        manifest = json.loads(manifest_path.read_text())
        region = manifest['region']
        path = ROOT / 'raw' / manifest['path']
        actual = digest(path,'sha256')
        if actual != manifest['sha256'] or path.stat().st_size != manifest['bytes']:
            raise RuntimeError(region + ' raw file verification failed')
        report['raw'].append({'region':region,'bytes':path.stat().st_size,'sha256':actual,'verified':True})
with psycopg.connect(**json.loads((ROOT / 'database.json').read_text()), row_factory=dict_row) as conn:
    conn.execute("SET statement_timeout='30s'")
    conn.execute(Path(__file__).with_name('relevance.sql').read_text())
    conn.execute(Path(__file__).with_name('search.sql').read_text())
    report['database'] = conn.execute('SELECT version(), postgis_full_version(), pg_size_pretty(pg_database_size(current_database())) AS size, pg_database_size(current_database()) AS bytes').fetchone()
    report['imports'] = conn.execute('SELECT i.region,i.rows_count,i.pbf_timestamp,i.loaded_at FROM osm.imports i JOIN osm.active_imports a ON a.import_id=i.id ORDER BY i.region').fetchall()
    report['categories'] = conn.execute('SELECT p.category,count(*) AS rows FROM osm.poi p JOIN osm.active_imports a ON a.import_id=p.import_id GROUP BY p.category ORDER BY rows DESC').fetchall()
    report['samples'] = {}
    report['query_ms'] = {}
    for name in ('故宫','拙政园','西湖','外滩','台北101','東京タワー','경복궁','Grand Palace','Hoan Kiem','Marina Bay Sands','Petronas','Malé'):
        started=time.perf_counter()
        report['samples'][name] = conn.execute('SELECT * FROM osm.search_places(%s,result_limit=>5)',(name,)).fetchall()
        report['query_ms'][name] = round((time.perf_counter()-started)*1000,2)
    report['nearby'] = conn.execute('SELECT * FROM osm.search_places(%s,center_lon=>121.49,center_lat=>31.24,radius_m=>3000,result_limit=>5)',('',)).fetchall()
    report['quality'] = conn.execute('SELECT count(*) AS rows,count(*) FILTER (WHERE opening_hours IS NOT NULL) AS with_opening_hours,count(*) FILTER (WHERE city IS NOT NULL) AS with_city,count(*) FILTER (WHERE NOT selectable) AS restricted_access FROM osm.poi p JOIN osm.active_imports a ON a.import_id=p.import_id').fetchone()
    conn.execute("SET LOCAL statement_timeout='180s'")
    conn.execute("SET LOCAL work_mem='64MB'")
    report['active_unique_objects'] = conn.execute('SELECT count(DISTINCT p.id) FROM osm.poi p JOIN osm.active_imports a ON a.import_id=p.import_id').fetchone()['count']
    conn.execute("SET LOCAL statement_timeout='30s'")
    conn.execute("SET LOCAL work_mem='4MB'")
    report['indexes'] = conn.execute("SELECT indexname FROM pg_indexes WHERE schemaname='osm' ORDER BY indexname").fetchall()
if (ROOT/'reader.json').exists():
    with psycopg.connect(**json.loads((ROOT/'reader.json').read_text()),row_factory=dict_row) as reader:
        perms=reader.execute("SELECT has_table_privilege(current_user,'osm.poi','SELECT') AS can_read,has_table_privilege(current_user,'osm.poi','INSERT') AS can_insert,has_table_privilege(current_user,'osm.poi','UPDATE') AS can_update,has_table_privilege(current_user,'osm.poi','DELETE') AS can_delete,has_schema_privilege(current_user,'osm','CREATE') AS can_create").fetchone()
        assert perms['can_read'] and not any(perms[k] for k in ('can_insert','can_update','can_delete','can_create'))
        reader.commit()
        try:
            reader.execute('SET TRANSACTION READ WRITE')
            reader.execute('DELETE FROM osm.poi WHERE false')
        except psycopg.errors.InsufficientPrivilege:
            reader.rollback()
            perms['write_denied_even_when_read_only_disabled']=True
        else:
            reader.rollback()
            raise RuntimeError('Reader could issue a write statement')
        report['reader_permissions']=perms
containers = subprocess.run(['sudo','-n','docker','ps','--format','{{.Names}} {{.Status}}'], check=True,capture_output=True,text=True).stdout.splitlines()
report['service_status']=next((line for line in containers if line.startswith('seatraces-osm-db ')),None)
report['other_running_containers']=len([line for line in containers if not line.startswith('seatraces-osm-db ')])
report['other_unhealthy_containers']=len([line for line in containers if not line.startswith('seatraces-osm-db ') and '(unhealthy)' in line])
disk=shutil.disk_usage(ROOT)
report['disk']={'total_bytes':disk.total,'free_bytes':disk.free}
stats=subprocess.run(['sudo','-n','docker','stats','seatraces-osm-db','--no-stream','--format','{{json .}}'],check=True,capture_output=True,text=True,timeout=20)
report['container_resources']=json.loads(stats.stdout)
path = ROOT / 'verification.json'
path.write_text(json.dumps(report,ensure_ascii=False,indent=2,default=str))
print(json.dumps(report,ensure_ascii=True,default=str))
