"""配置并检查地点查询专用的数据库账号。"""
import argparse
import json
import os
from pathlib import Path
import secrets
import sys

ROOT=Path('/home/ubuntu/seatraces-osm')
sys.path.insert(0,str(ROOT/'.deps'))
import psycopg
from psycopg import sql
from psycopg.rows import dict_row

parser=argparse.ArgumentParser()
parser.add_argument('--provision',action='store_true')
parser.add_argument('--query',default='外滩')
parser.add_argument('--category')
parser.add_argument('--lon',type=float)
parser.add_argument('--lat',type=float)
parser.add_argument('--radius',type=float,default=10000)
args=parser.parse_args()
config_path=ROOT/'reader.json'
if args.provision:
    os.umask(0o077)
    with psycopg.connect(**json.loads((ROOT/'database.json').read_text())) as conn:
        if config_path.exists():
            config=json.loads(config_path.read_text())
        else:
            if conn.execute("SELECT 1 FROM pg_roles WHERE rolname='seatraces_osm_reader'").fetchone():
                raise RuntimeError('Reader exists without local configuration; inspect before changing credentials')
            config={**json.loads((ROOT/'database.json').read_text()),'user':'seatraces_osm_reader','password':secrets.token_urlsafe(32)}
            config_path.write_text(json.dumps(config))
            config_path.chmod(0o600)
        if not conn.execute("SELECT 1 FROM pg_roles WHERE rolname='seatraces_osm_reader'").fetchone():
            conn.execute(sql.SQL('CREATE ROLE seatraces_osm_reader LOGIN PASSWORD {} CONNECTION LIMIT 4').format(sql.Literal(config['password'])))
        conn.execute('GRANT CONNECT ON DATABASE seatraces_osm TO seatraces_osm_reader')
        conn.execute('GRANT USAGE ON SCHEMA osm TO seatraces_osm_reader')
        conn.execute('GRANT SELECT ON ALL TABLES IN SCHEMA osm TO seatraces_osm_reader')
        conn.execute('ALTER DEFAULT PRIVILEGES IN SCHEMA osm GRANT SELECT ON TABLES TO seatraces_osm_reader')
        conn.execute("ALTER ROLE seatraces_osm_reader SET statement_timeout='5s'")
        conn.execute("ALTER ROLE seatraces_osm_reader SET default_transaction_read_only=on")
        conn.execute('REVOKE CREATE ON SCHEMA osm FROM PUBLIC')
    print('Read-only search account configured; credentials stored only in reader.json (0600)')
with psycopg.connect(**json.loads(config_path.read_text()),row_factory=dict_row) as conn:
    rows=conn.execute('SELECT * FROM osm.search_places(%s,%s,%s,%s,%s,30)',(args.query,args.category,args.lon,args.lat,args.radius)).fetchall()
    print(json.dumps({'query':args.query,'count':len(rows),'places':rows},ensure_ascii=True,default=str))
