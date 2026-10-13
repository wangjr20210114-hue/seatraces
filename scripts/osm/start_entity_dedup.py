"""One resumable, detached batch. No credentials, schedules or provider calls."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from rebuild_sites import atomic,now

ROOT=Path('/home/ubuntu/seatraces-osm')
STAGE=Path(__file__).resolve().parent


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--worker',action='store_true');args=parser.parse_args()
    out=ROOT/'audits/entity-dedup';out.mkdir(parents=True,exist_ok=True)
    pidfile=out/'worker.pid'
    if args.worker:
        status=dict(status='running',startedAt=now(),pid=os.getpid(),stage=str(STAGE))
        atomic(out/'batch-status.json',status)
        try:
            for name,extra in [('rebuild_entities.py',['--run']),('install_entity_reader.py',[])]:
                status.update(phase=name,updatedAt=now());atomic(out/'batch-status.json',status)
                subprocess.run([sys.executable,str(STAGE/name),*extra],cwd=STAGE,check=True)
            status.update(status='complete',finishedAt=now())
        except BaseException as exc:
            status.update(status='failed',finishedAt=now(),error=type(exc).__name__+': '+str(exc));raise
        finally:atomic(out/'batch-status.json',status)
        return
    if pidfile.exists():
        pid=int(pidfile.read_text());cmd=Path('/proc')/str(pid)/'cmdline'
        if cmd.exists() and b'start_entity_dedup.py' in cmd.read_bytes():
            print(json.dumps(dict(alreadyRunning=True,pid=pid)));return
    env=os.environ.copy()
    env['PYTHONPATH']=os.pathsep.join([str(STAGE),str(ROOT/'scripts/osm'),str(ROOT/'.deps-site'),str(ROOT/'.deps')])
    env['PYTHONUNBUFFERED']='1'
    with (out/'worker.log').open('ab') as log:
        p=subprocess.Popen(['nice','-n','15','ionice','-c','3',sys.executable,str(__file__),'--worker'],
            cwd=STAGE,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    pidfile.write_text(str(p.pid))
    print(json.dumps(dict(started=True,pid=p.pid,status=str(out/'status.json'),batchStatus=str(out/'batch-status.json'),newCredentials=False)))


if __name__=='__main__':main()
