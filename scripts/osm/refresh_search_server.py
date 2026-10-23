"""更新地点检索函数。"""
import json
from pathlib import Path
import sys
root=Path('/home/ubuntu/seatraces-osm')
sys.path.insert(0,str(root/'.deps'))
import psycopg
with psycopg.connect(**json.loads((root/'database.json').read_text())) as conn:
    for name in ('relevance.sql','search.sql'):
        conn.execute(Path(__file__).with_name(name).read_text())
print(json.dumps({'search_functions_updated':True}))
