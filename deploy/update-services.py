"""更新周边服务功能，备份数据并检查部署结果。"""
from pathlib import Path
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tarfile, time, urllib.request, urllib.error, secrets, uuid

parser=argparse.ArgumentParser()
parser.add_argument('--commit',required=True)
parser.add_argument('--archive-sha256',required=True)
args=parser.parse_args()
if not re.fullmatch('[a-f0-9]{40}',args.commit) or not re.fullmatch('[a-f0-9]{64}',args.archive_sha256):raise SystemExit('Invalid release identity')
if os.geteuid()!=0:raise SystemExit('Run with sudo; existing deployment credentials remain root-only')
root=Path('/home/ubuntu/seatraces-app')
if not (root/'migration-verification.json').is_file():raise SystemExit('Initial deployment is not verified')
stage=root/'incoming'/('services-'+args.commit[:12]);stage.mkdir(parents=True,exist_ok=True,mode=0o700)
status=root/'services-update-status.json'
def report(phase,**extra):
    value={'phase':phase,'commit':args.commit,'updatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),**extra}
    status.write_text(json.dumps(value,indent=2));status.chmod(0o600);print(json.dumps(value),flush=True)
def run(command,**kw):return subprocess.run(command,check=True,**kw)
def healthy():
    with urllib.request.urlopen('http://127.0.0.1:8787/api/health',timeout=3) as r:return r.status==200 and json.load(r).get('ok')
envfile=root/'.env.deploy';old=envfile.read_text();image=re.search(r'^SEATRACES_IMAGE=(.+)$',old,re.M)
if not image:raise SystemExit('Current deployment image missing')
report('downloading',previousImage=image.group(1))
archive=stage/'source.tar.gz'
try:
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest()!=args.archive_sha256:
        with urllib.request.urlopen('https://codeload.github.com/wangjr20210114-hue/seatraces/tar.gz/'+args.commit,timeout=45) as response,archive.open('wb') as f:
            count=0
            while True:
                chunk=response.read(1024*1024)
                if not chunk:break
                count+=len(chunk)
                if count>80*1024*1024:raise RuntimeError('Source archive exceeds expected size')
                f.write(chunk)
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=args.archive_sha256:raise RuntimeError('Source checksum mismatch')
    extract=stage/'checkout';extract.mkdir(exist_ok=True)
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            target=(extract/member.name).resolve()
            if not target.is_relative_to(extract.resolve()) or member.issym() or member.islnk() or not(member.isfile() or member.isdir()):raise RuntimeError('Unsafe archive member')
        tar.extractall(extract)
    source=extract/('seatraces-'+args.commit)
    if not (source/'server/trip-services-schema.sql').is_file():raise RuntimeError('Release migration missing')
    image_tag='seatraces-business:services-'+args.commit[:12]
    report('building',image=image_tag)
    with (stage/'build.log').open('w') as log:run(['docker','build','-t',image_tag,str(source)],stdout=log,stderr=log)
    report('backing_up')
    config=json.loads(Path('/home/ubuntu/seatraces-osm/database.json').read_text())
    backup=root/'backups'/('business-before-services-'+time.strftime('%Y%m%d-%H%M%S')+'.dump')
    with backup.open('xb') as f:
        backup.chmod(0o600)
        run(['docker','exec','seatraces-osm-db','pg_dump','-U',config['user'],'-d','seatraces_business','-Fc'],stdout=f)
    with backup.open('rb') as f:run(['docker','exec','-i','seatraces-osm-db','pg_restore','--list'],stdin=f,stdout=subprocess.DEVNULL)
    report('migrating',backup=str(backup))
    sys.path.insert(0,'/home/ubuntu/seatraces-osm/.deps')
    import psycopg
    target={**config,'dbname':'seatraces_business'};target.pop('database',None)
    with psycopg.connect(**target) as db:
        db.execute('SET ROLE seatraces_business_owner')
        db.execute((source/'server/trip-services-schema.sql').read_text())
        db.execute('GRANT SELECT,INSERT,UPDATE,DELETE ON trip_service_recommendations TO seatraces_business_app')
    updated=re.sub(r'^SEATRACES_IMAGE=.+$', 'SEATRACES_IMAGE='+image_tag,old,flags=re.M)
    def set_env(value):
        temporary=root/'.env.deploy.next';temporary.write_text(value);temporary.chmod(0o600);temporary.replace(envfile)
    compose=['docker','compose','--env-file',str(envfile),'-f',str(root/'compose.yaml')]
    try:
        report('activating');set_env(updated);run(compose+['up','-d','backend','frontend'])
        for attempt in range(30):
            try:
                if healthy():break
            except Exception:pass
            time.sleep(1)
        else:raise RuntimeError('Backend health check failed')
        gateway=re.search(r'^CADDY_BRIDGE_GATEWAY=(.+)$',old,re.M).group(1)
        with urllib.request.urlopen('http://'+gateway+':8788/trip-services.js',timeout=5) as r:
            if r.status!=200 or b'renderTripServicesPage' not in r.read():raise RuntimeError('New frontend missing')
        try:urllib.request.urlopen('http://127.0.0.1:8787/api/journey/trips/00000000-0000-4000-8000-000000000001/services',timeout=5)
        except urllib.error.HTTPError as exc:
            if exc.code!=401:raise RuntimeError('Authentication check failed')
        else:raise RuntimeError('Unauthenticated service request was accepted')
        cookie='';test_user=None
        def api(path,body=None,method=None):
            global cookie
            request=urllib.request.Request('http://127.0.0.1:8787/api'+path,data=json.dumps(body).encode() if body is not None else None,method=method or ('POST' if body is not None else 'GET'),headers={'Content-Type':'application/json','X-Seatraces':'1','Cookie':cookie})
            with urllib.request.urlopen(request,timeout=35) as response:
                if response.headers.get('Set-Cookie'):cookie=response.headers['Set-Cookie'].split(';')[0]
                return json.load(response)
        try:
            test_user=api('/auth/register',{'username':'services_check_'+secrets.token_hex(4),'password':secrets.token_hex(24),'nickname':'部署验收'})['user']['id']
            trip=str(uuid.uuid4())
            plan={'schemaVersion':'journey/2','cities':[{'id':'smoke-beijing','name':'北京','lat':39.9163,'lng':116.3972}], 'days':[{'city':'北京','cityId':'smoke-beijing','date':'2026-10-20','stops':[{'id':'smoke-anchor','name':'故宫周边验收锚点','lat':39.9163,'lng':116.3972,'leave':'12:00','country':'CN','mainlandCityVerified':True}]}]}
            with psycopg.connect(**target) as db:
                db.execute('INSERT INTO trips(id,user_id,title,request,plan) VALUES(%s,%s,%s,%s,%s)',(trip,test_user,'一次性吃住验收',json.dumps({'start':'2026-10-20','end':'2026-10-20','interests':[]}),json.dumps(plan)))
                db.execute('INSERT INTO trip_versions(trip_id,version,plan,reason) VALUES(%s,1,%s,%s)',(trip,json.dumps(plan),'部署验收'))
            base='/journey/trips/'+trip+'/services'
            result=api(base+'/recommendations',{'day':0})
            usable=[s for s in result['slots'] if s['status'] in ('live','snapshot') and s['items']]
            if len(usable)!=3:raise RuntimeError('Real catalog did not provide all three service groups')
            lunch=usable[0];choice={'version':result['version'],'recommendationId':lunch['recommendationId'],'placeId':lunch['items'][0]['id']}
            slot=base+'/'+lunch['id'];api(slot+'/preview',choice);saved=api(slot,choice,'PUT')
            if api('/trips/'+trip)['plan']['services'][lunch['id']]['candidate']['id']!=choice['placeId']:raise RuntimeError('Selection persistence verification failed')
            report('smoke_passed',groups=len(usable),savedVersion=saved['trip']['version'])
        finally:
            if test_user:
                with psycopg.connect(**target) as db:db.execute('DELETE FROM users WHERE id=%s',(test_user,))
    except Exception:
        set_env(old);run(compose+['up','-d','backend','frontend']);report('rolled_back',previousImage=image.group(1));raise
    shutil.copy2(source/'API_REFERENCE.md',root/'API_REFERENCE.md')
    report('completed',image=image_tag,backup=str(backup),url='https://trip.seatraces.com',newCredentials=False)
except Exception as exc:
    report('failed',error=type(exc).__name__+': '+str(exc));raise
