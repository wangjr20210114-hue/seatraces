"""Run a single idempotent build, then install and verify its read API."""
from pathlib import Path
import subprocess
import sys
import json
from datetime import datetime,timezone

stage=Path(__file__).resolve().parent
root=Path('/home/ubuntu/seatraces-osm')
out=root/'audits/containment-hierarchy'
out.mkdir(parents=True,exist_ok=True)
try:
    for filename,args in [('rebuild_containment.py',['--run']),('install_containment_reader.py',[])]:
        subprocess.run([sys.executable,str(stage/filename),*args],check=True,cwd=stage)
    status='complete';error=None
except BaseException as exc:
    status='failed';error=str(exc)
    raise
finally:
    (out/'batch-status.json').write_text(json.dumps({'status':status,'finishedAt':datetime.now(timezone.utc).isoformat(),'error':error}),encoding='utf8')
