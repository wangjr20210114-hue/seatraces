"""更新餐饮推荐侧栏和片区展示功能。"""
from pathlib import Path
import argparse, fcntl, hashlib, json, os, re, subprocess, tarfile, time, urllib.request, urllib.error

parser = argparse.ArgumentParser()
parser.add_argument('--commit', required=True)
parser.add_argument('--archive-sha256', required=True)
args = parser.parse_args()
if not re.fullmatch('[a-f0-9]{40}', args.commit) or not re.fullmatch('[a-f0-9]{64}', args.archive_sha256):
    raise SystemExit('Invalid release identity')
if os.geteuid() != 0:
    raise SystemExit('Run with sudo')
root = Path('/home/ubuntu/seatraces-app')
if not (root/'migration-verification.json').is_file():
    raise SystemExit('Existing verified deployment required')
lock = (root/'drawer-update.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
stage = root/'incoming'/('drawer-'+args.commit[:12])
stage.mkdir(parents=True, exist_ok=True, mode=0o700)
status = root/'drawer-update-status.json'
def report(phase, **extra):
    value = dict(phase=phase, commit=args.commit, updatedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()), **extra)
    tmp=status.with_suffix('.next'); tmp.write_text(json.dumps(value,indent=2)); tmp.chmod(0o600); tmp.replace(status)
    print(json.dumps(value), flush=True)
def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)
def get(path):
    with urllib.request.urlopen('http://127.0.0.1:8787'+path,timeout=5) as response:
        return response.read()
envfile=root/'.env.deploy'
old=envfile.read_text()
prior=re.search(r'^SEATRACES_IMAGE=(.+)$',old,re.M)
if not prior: raise SystemExit('Current image missing')
compose=['docker','compose','--env-file',str(envfile),'-f',str(root/'compose.yaml')]
def set_env(text):
    tmp=root/'.env.deploy.next'; tmp.write_text(text); tmp.chmod(0o600); tmp.replace(envfile)
activated=False
try:
    report('downloading', previousImage=prior.group(1))
    archive=stage/'source.tar.gz'
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest()!=args.archive_sha256:
        with urllib.request.urlopen('https://codeload.github.com/wangjr20210114-hue/seatraces/tar.gz/'+args.commit,timeout=45) as response,archive.open('wb') as out:
            count=0
            while True:
                chunk=response.read(1024*1024)
                if not chunk: break
                count+=len(chunk)
                if count>80*1024*1024: raise RuntimeError('Archive too large')
                out.write(chunk)
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=args.archive_sha256: raise RuntimeError('Source checksum mismatch')
    extract=stage/'checkout';extract.mkdir(exist_ok=True)
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            if not (extract/member.name).resolve().is_relative_to(extract.resolve()) or member.issym() or member.islnk() or not(member.isfile() or member.isdir()): raise RuntimeError('Unsafe archive member')
        tar.extractall(extract)
    source=extract/('seatraces-'+args.commit)
    if not (source/'public/map-scene.js').is_file(): raise RuntimeError('Map release missing')
    tag='seatraces-business:drawer-'+args.commit[:12]
    report('building', image=tag)
    with (stage/'build.log').open('w') as log: run(['docker','build','-t',tag,str(source)],stdout=log,stderr=log)
    report('activating', image=tag)
    set_env(re.sub(r'^SEATRACES_IMAGE=.+$','SEATRACES_IMAGE='+tag,old,flags=re.M)); activated=True
    run(compose+['up','-d','backend','frontend'])
    for attempt in range(30):
        try:
            if json.loads(get('/api/health')).get('ok'): break
        except Exception: pass
        time.sleep(1)
    else: raise RuntimeError('Backend health check failed')
    gateway=re.search(r'^CADDY_BRIDGE_GATEWAY=(.+)$',old,re.M).group(1)
    for file,marker in [('journey.js',b'mountServiceMapDock'),('map-scene.js',b'selectionFocus'),('service-map-dock.js',b'service-drawer'),('amap-view.js',b'lastFocusKey'),('service-place-link.js',b'uri.amap.com/marker')]:
        with urllib.request.urlopen('http://'+gateway+':8788/'+file,timeout=5) as response:
            if marker not in response.read(): raise RuntimeError('Frontend release mismatch: '+file)
    for path in ['/api/journey/cities/beijing/boundary','/api/journey/trips/00000000-0000-4000-8000-000000000001/services']:
        try: get(path)
        except urllib.error.HTTPError as exc:
            if exc.code!=401: raise RuntimeError('Authentication check failed')
        else: raise RuntimeError('Unauthenticated request accepted')
    (root/'API_REFERENCE.md').write_bytes((source/'API_REFERENCE.md').read_bytes())
    report('completed', image=tag, previousImage=prior.group(1), url='https://trip.seatraces.com', schemaChanges=False, newCredentials=False)
except Exception as exc:
    if activated:
        set_env(old)
        try:
            run(compose+['up','-d','backend','frontend'])
            report('rolled_back', previousImage=prior.group(1), error=type(exc).__name__)
        except Exception: report('rollback_failed', previousImage=prior.group(1), error=type(exc).__name__)
    else: report('failed', error=type(exc).__name__)
    raise
