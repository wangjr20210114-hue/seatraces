"""停用已被完整数据覆盖的试点快照。"""
import json
from pathlib import Path
import sys

ROOT=Path('/home/ubuntu/seatraces-osm')
sys.path.insert(0,str(ROOT/'.deps'))
import psycopg

report={'pilot_deactivated':False}
with psycopg.connect(**json.loads((ROOT/'database.json').read_text())) as conn:
    conn.execute("SET statement_timeout='60s'")
    china=conn.execute("SELECT i.id,i.pbf_timestamp FROM osm.imports i JOIN osm.active_imports a ON a.import_id=i.id WHERE a.region='china'").fetchone()
    pilot=conn.execute("SELECT i.id,i.pbf_timestamp FROM osm.imports i JOIN osm.active_imports a ON a.import_id=i.id WHERE a.region='shanghai'").fetchone()
    if not china: raise RuntimeError('National snapshot is not active')
    if pilot and china[1] and pilot[1] and china[1]>=pilot[1]:
        missing=conn.execute('SELECT count(*) FROM osm.poi p WHERE p.import_id=%s AND NOT EXISTS(SELECT 1 FROM osm.poi c WHERE c.import_id=%s AND c.id=p.id)',(pilot[0],china[0])).fetchone()[0]
        report['pilot_objects_missing_from_china']=missing
        if missing==0:
            conn.execute("DELETE FROM osm.active_imports WHERE region='shanghai' AND import_id=%s",(pilot[0],))
            report['pilot_deactivated']=True
    report['active_unique_objects']=conn.execute('SELECT count(DISTINCT p.id) FROM osm.poi p JOIN osm.active_imports a ON a.import_id=p.import_id').fetchone()[0]
    report['disk']=dict(conn.execute("SELECT 'database_bytes',pg_database_size(current_database())").fetchall())
(ROOT/'finalization.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
