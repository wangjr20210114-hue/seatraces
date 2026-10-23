"""依次重建 site 层级、安装接口并验证结果。"""
from pathlib import Path
import subprocess
import sys

root=Path(__file__).resolve().parent
for name,args in [('rebuild_sites.py',['--run']),('install_site_reader.py',[])]:
    completed=subprocess.run([sys.executable,str(root/name),*args])
    if completed.returncode:
        raise SystemExit(completed.returncode)
