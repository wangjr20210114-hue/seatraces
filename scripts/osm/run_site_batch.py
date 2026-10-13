"""Sequential batch: rebuild/validate/publish, then install and verify reader."""
from pathlib import Path
import subprocess
import sys

root=Path(__file__).resolve().parent
for name,args in [('rebuild_sites.py',['--run']),('install_site_reader.py',[])]:
    completed=subprocess.run([sys.executable,str(root/name),*args])
    if completed.returncode:
        raise SystemExit(completed.returncode)
