"""Launch one background batch on the existing server; no new login keys or scheduler."""
import os
from pathlib import Path
import subprocess
import sys
import json

root=Path('/home/ubuntu/seatraces-osm');stage=Path(__file__).resolve().parent
out=root/'audits/containment-hierarchy';out.mkdir(parents=True,exist_ok=True)
pidfile=out/'worker.pid'
if pidfile.exists():
    pid=int(pidfile.read_text())
    cmdline=Path('/proc')/str(pid)/'cmdline'
    if cmdline.exists() and b'run_containment_batch.py' in cmdline.read_bytes():
        print(json.dumps({'alreadyRunning':True,'pid':pid}));sys.exit(0)
env=os.environ.copy()
env['PYTHONPATH']=os.pathsep.join([str(stage),str(root/'scripts/osm'),str(root/'.deps-site'),str(root/'.deps')])
env['PYTHONUNBUFFERED']='1'
with (out/'worker.log').open('ab') as log:
    worker=subprocess.Popen(['nice','-n','15','ionice','-c','3',sys.executable,str(stage/'run_containment_batch.py')],
       stdin=subprocess.DEVNULL,stdout=log,stderr=log,cwd=stage,env=env,start_new_session=True)
pidfile.write_text(str(worker.pid))
print(json.dumps({'started':True,'pid':worker.pid,'status':str(out/'status.json'),'batchStatus':str(out/'batch-status.json'),
                  'log':str(out/'worker.log'),'maxDepth':8,'newCredentials':False}))
