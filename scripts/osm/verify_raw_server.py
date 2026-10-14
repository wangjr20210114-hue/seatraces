"""Verify one uploaded raw PBF against its trusted transfer manifest."""
import argparse
import json
from pathlib import Path
from download import REGIONS, digest

parser=argparse.ArgumentParser()
parser.add_argument('region',choices=REGIONS)
args=parser.parse_args()
root=Path('/home/ubuntu/seatraces-osm/raw')
source=json.loads((root/(args.region+'-manifest.json')).read_text())
path=root/source['path']
if path.resolve().parent!=root.resolve() or source['region']!=args.region:
    raise RuntimeError('Unexpected source path or region')
if path.stat().st_size!=source['bytes'] or digest(path,'sha256')!=source['sha256']:
    raise RuntimeError('Raw file size or SHA-256 mismatch; do not accept this upload')
print(json.dumps({'region':args.region,'verified':True,'bytes':source['bytes'],'sha256':source['sha256']}))
