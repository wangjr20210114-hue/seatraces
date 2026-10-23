"""安装地点查询服务并检查运行状态。"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from urllib.request import urlopen

ROOT = Path('/home/ubuntu/seatraces-osm')
UNIT = 'seatraces-osm-catalog.service'
TARGET = Path('/etc/systemd/system') / UNIT

def run(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True)

def status():
    result = run('sudo', '-n', 'systemctl', 'show', UNIT, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'UnitFileState')
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)

def ready():
    last = None
    for _ in range(12):
        try:
            with urlopen('http://127.0.0.1:8791/health', timeout=3) as r:
                value = json.load(r)
            if value.get('service') == 'seatraces-osm' and value.get('readOnly') is True:
                return value
        except Exception as e:
            last = e
        time.sleep(1)
    raise RuntimeError('Catalog health check failed') from last

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--unit', type=Path, default=ROOT/'deploy'/UNIT)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    source = args.unit.read_text()
    assert 'Description=SeaTraces read-only OSM catalog (loopback)' in source
    assert 'User=ubuntu' in source and '--port 8791' in source
    assert (ROOT/'reader.json').is_file() and (ROOT/'scripts/osm/place_service.py').is_file()
    if TARGET.exists() and TARGET.read_text() != source:
        raise RuntimeError('An existing unit differs; inspect it before replacement')
    run('systemd-analyze', 'verify', str(args.unit))
    if not args.apply:
        print(json.dumps({'validated': True, 'applied': False})); return

    stopped_old = False
    try:
        pid_file = ROOT/'catalog-service.pid'
        if pid_file.exists():
            pid = int(pid_file.read_text().strip())
            proc = Path('/proc')/str(pid)
            if proc.exists():
                command = (proc/'cmdline').read_bytes().split(b'\0')
                expected = str(ROOT/'scripts/osm/place_service.py').encode()
                if expected not in command or proc.stat().st_uid != os.getuid():
                    raise RuntimeError('Previous process identity mismatch')
                os.kill(pid, signal.SIGTERM)
                stopped_old = True
                for _ in range(50):
                    if not proc.exists(): break
                    time.sleep(.1)
                else: raise RuntimeError('Previous process did not stop')
            pid_file.unlink()
        run('sudo','-n','install','-o','root','-g','root','-m','0644',str(args.unit),str(TARGET))
        run('sudo','-n','systemctl','daemon-reload')
        run('sudo','-n','systemctl','enable','--now',UNIT)
        health = ready()
        before = status()
        run('sudo','-n','systemctl','restart',UNIT)
        ready()
        after = status()
        assert after['ActiveState'] == 'active' and after['UnitFileState'] == 'enabled'
        assert int(after['MainPID']) > 0 and before['MainPID'] != after['MainPID']
        with urlopen('http://127.0.0.1:8791/coverage',timeout=8) as r:
            coverage=json.load(r)
        listeners = run('ss','-ltnH','sport = :8791').stdout.splitlines()
        assert listeners and all('127.0.0.1:8791' in row for row in listeners)
        report={'at':datetime.now(timezone.utc).isoformat(),'service':UNIT,'health':health,
                'systemd':after,'restartVerified':True,'previousPID':before['MainPID'],
                'loopbackOnly':True,'regions':len(coverage['regions']),'rows':coverage['rows'],
                'rebootTested':False,'credentialsCreated':False}
        (ROOT/'catalog-service-systemd.json').write_text(json.dumps(report,indent=2))
        print(json.dumps(report,indent=2))
    except Exception:
        if stopped_old:
            run('sudo','-n','systemctl','disable','--now',UNIT,check=False)
            with (ROOT/'catalog-service.log').open('ab') as log:
                child=subprocess.Popen(['/usr/bin/python3',str(ROOT/'scripts/osm/place_service.py')],
                    cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
            (ROOT/'catalog-service.pid').write_text(str(child.pid))
        raise

if __name__ == '__main__': main()
