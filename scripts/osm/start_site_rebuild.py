"""Start one detached server batch; no recurring job or persistent SSH access."""
import os
from pathlib import Path
import subprocess
import sys
import json

ROOT=Path('/home/ubuntu/seatraces-osm')


def main():
    stage=Path(__file__).resolve().parent
    output=ROOT/'audits/site-hierarchy'
    output.mkdir(parents=True,exist_ok=True)
    env=os.environ.copy()
    env['PYTHONPATH']=os.pathsep.join([str(stage),str(ROOT/'scripts/osm'),str(ROOT/'.deps-site'),str(ROOT/'.deps')])
    env['PYTHONUNBUFFERED']='1'
    # CPU and IO niceness preserve the existing search service while processing.
    command=['nice','-n','15','ionice','-c','3',sys.executable,str(stage/'run_site_batch.py')]
    with (output/'worker.log').open('ab') as log:
        worker=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=log,stderr=log,
                                env=env,start_new_session=True,cwd=stage)
    (output/'worker.pid').write_text(str(worker.pid))
    print(json.dumps({'started':True,'pid':worker.pid,'log':str(output/'worker.log'),
                      'status':str(output/'status.json'),'autoPublish':True,'readServiceRestarted':False}))


if __name__=='__main__':main()
