"""汇总地点数据交付和验证结果。"""
import argparse
from datetime import datetime,timedelta,timezone
import json
from pathlib import Path
import re
import sys

parser=argparse.ArgumentParser()
parser.add_argument('--clear',action='store_true')
args=parser.parse_args()
root=Path('/home/ubuntu/seatraces-osm')
r=json.loads((root/'verification.json').read_text())
backups=sorted((root/'backups').glob('osm-*.json'))
b=json.loads(backups[-1].read_text()) if backups else {}
c=json.loads((root/'access-cleanup.json').read_text()) if (root/'access-cleanup.json').exists() else {}
a=json.loads((root/'access-active.json').read_text()) if (root/'access-active.json').exists() else {}
if args.clear and sys.stdout.isatty(): print('\033[2J\033[H',end='')
print('SEATRACES / OSM DATA DELIVERY')
verified=datetime.fromisoformat(r['verified_at'].replace('Z','+00:00')).astimezone(timezone(timedelta(hours=8)))
print('Verified (+08):',verified.strftime('%Y-%m-%d %H:%M:%S'))
print('----------------------------------------')
for item in r['imports']: print(f"{item['region']:26} {item['rows_count']:>12,} rows")
print(f"{'Unique IDs':26} {r['active_unique_objects']:>12,}")
raw=r.get('raw',[])
raw_status='SHA256 OK' if raw and all(x.get('verified') for x in raw) else 'NOT VERIFIED'
print(f"Raw PBF: {sum(x['bytes'] for x in raw):,} bytes / {raw_status}")
postgis=re.search(r'POSTGIS="([^ "]+)',r['database']['postgis_full_version']).group(1)
print('PostgreSQL',r['database']['version'].split()[1],'+ PostGIS',postgis)
print('Database: ',r['database']['size'])
print('Read-only account:', 'PASS' if r.get('reader_permissions',{}).get('write_denied_even_when_read_only_disabled') else 'NOT VERIFIED')
full_backup=b.get('restore_verified') and {item['region'] for item in r['imports']} <= {item[0] for item in b.get('verified_imports',[])}
print('Active regions backup restore:', 'PASS' if full_backup else 'PENDING')
cleaned=c.get('remaining_matching_entries')==0 and (not a or c.get('public_blob')==a.get('public_blob'))
print('Temporary SSH key:', 'REMOVED' if cleaned else 'PENDING CLEANUP')
print('Service:',r.get('service_status','unknown'))
if (root/'benchmark.json').exists():
    benchmark=json.loads((root/'benchmark.json').read_text())
    queries=benchmark['sequential']
    name_ms=[item['p50_ms'] for key,item in queries.items() if not key.startswith('nearby-')]
    print(f"DB-only name P50: {min(name_ms):.2f}-{max(name_ms):.2f} ms")
    print(f"Nearby P50: SH {queries['nearby-shanghai']['p50_ms']:.0f} / Tokyo {queries['nearby-tokyo']['p50_ms']:.0f} ms")
    print(f"First nearby: {queries['nearby-shanghai']['first_ms']/1000:.2f} / {queries['nearby-tokyo']['first_ms']/1000:.2f} s")
    print(f"Two-connection P95: {benchmark['two_connections']['p95_ms']:.0f} ms")
print('----------------------------------------')
print('Data: /home/ubuntu/seatraces-osm')
print('OSM contributors / ODbL 1.0')
