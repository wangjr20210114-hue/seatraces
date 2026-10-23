"""采集海外地点的多语言检索样本。"""
import json
from pathlib import Path
import sys
root=Path('/home/ubuntu/seatraces-osm')
sys.path.insert(0,str(root/'.deps'))
import psycopg
from psycopg.rows import dict_row

queries=['東京タワー','경복궁','Grand Palace','Hồ Hoàn Kiếm','Marina Bay Sands','Petronas Twin Towers','Sultan Omar Ali','Malé']
report={}
with psycopg.connect(**json.loads((root/'reader.json').read_text()),row_factory=dict_row,autocommit=True) as conn:
    for query in queries:
        rows=conn.execute('SELECT id,name,aliases,category,lon,lat,source_timestamp FROM osm.search_places(%s,result_limit=>5)',(query,)).fetchall()
        for row in rows:
            row['extract_regions']=[item['region'] for item in conn.execute('SELECT i.region FROM osm.poi p JOIN osm.active_imports a ON a.import_id=p.import_id JOIN osm.imports i ON i.id=p.import_id WHERE p.id=%s ORDER BY i.region',(row['id'],)).fetchall()]
        report[query]=rows
(root/'foreign-samples.json').write_text(json.dumps(report,ensure_ascii=False,indent=2,default=str))
print(json.dumps({key:{'results':len(value),'names':[row['name'] for row in value]} for key,value in report.items()},ensure_ascii=True))
