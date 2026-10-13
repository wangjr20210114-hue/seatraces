"""Run the importer with server-local credentials; no passwords in process arguments."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import sys

ROOT = Path('/home/ubuntu/seatraces-osm')
sys.path.insert(0, str(ROOT / '.deps'))
import psycopg
from download import REGIONS, digest

parser = argparse.ArgumentParser()
parser.add_argument('region', choices=REGIONS)
parser.add_argument('--allow-raw-pending', action='store_true', help='Import verified POI artifact before archiving its raw PBF on this server; raw source must already be verified locally')
args = parser.parse_args()
if shutil.disk_usage(ROOT).free < 12 * 1024**3:
    raise RuntimeError('Retain at least 12 GiB before country import for backups and existing services')
source = json.loads((ROOT / 'raw' / (args.region + '-manifest.json')).read_text())
raw_path = ROOT / 'raw' / source['path']
if raw_path.resolve().parent != (ROOT / 'raw').resolve():
    raise RuntimeError('Raw artifact must be inside the project raw directory')
raw_complete = raw_path.is_file() and raw_path.stat().st_size == source['bytes']
if raw_complete:
    if digest(raw_path, 'sha256') != source['sha256']:
        raise RuntimeError('Server raw PBF checksum mismatch')
elif not args.allow_raw_pending or not source.get('verified'):
    raise RuntimeError('Complete verified raw PBF required (or explicitly allow locally verified raw source pending upload)')
else:
    print(json.dumps({'event':'raw_archive_pending','region':args.region,'pbf_sha256':source['sha256']}), flush=True)
processed_manifest = json.loads((ROOT / 'processed' / (args.region + '.jsonl.gz.json')).read_text())
if processed_manifest['pbf_sha256'] != source['sha256']:
    raise RuntimeError('Raw and processed source snapshots differ')
spec = importlib.util.spec_from_file_location('osm_importer', Path(__file__).with_name('import.py'))
loader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)
with psycopg.connect(**json.loads((ROOT / 'database.json').read_text())) as conn:
    loader.load(ROOT / 'processed' / (args.region + '.jsonl.gz'), args.region, conn, spatial=True)
