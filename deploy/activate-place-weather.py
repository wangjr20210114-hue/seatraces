"""One-shot activation of existing bounded place semantics and Amap forecast.

No credentials, schema changes, downloads, model training or arbitrary commands.
The application image remains the reviewed mail/intelligence release.
"""
from pathlib import Path
import concurrent.futures,hashlib,json,os,re,subprocess,sys,threading,time,urllib.request,urllib.error,uuid

COMMIT='c7de59ddaa474eb67452182e0de1f8aa4f658fad'
ROOT=Path('/home/ubuntu/seatraces-app');STATE=Path('/var/lib/seatraces/git-deploy')
MODEL_FILES={'config.json':'d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',
 'tokenizer.json':'48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
 'tokenizer_config.json':'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
 'special_tokens_map.json':'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
 'onnx/model_quantized.onnx':'15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc'}

def run(args,timeout=90):
    r=subprocess.run(args,capture_output=True,timeout=timeout)
    if r.returncode:raise RuntimeError('SERVER_COMMAND_FAILED')
    return r.stdout

def save(path,value):
    if path.is_symlink():raise RuntimeError('UNEXPECTED_FILE_LINK')
    next_path=path.with_name(path.name+'.capability-next-'+str(os.getpid()))
    with next_path.open('xb') as f:os.fchmod(f.fileno(),0o600);f.write(value)
    next_path.replace(path)

def enabled_env(raw):
    lines=[s for s in raw.decode('utf8').splitlines() if not re.match(r'^\s*(?:export\s+)?EMBEDDING_ENABLED\s*=',s)]
    return ('\n'.join(lines)+'\nEMBEDDING_ENABLED=true\n').encode()

def report(phase,**extra):
    record=STATE/(COMMIT+'.json');v=json.loads(record.read_text())
    if v.get('phase')!='completed':raise RuntimeError('REVIEWED_RELEASE_NOT_COMPLETED')
    details={'phase':phase,'updatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),**extra}
    v['placeWeatherActivation']=details;save(record,json.dumps(v,indent=2).encode());print(json.dumps(details),flush=True)

def compose():return ['docker','compose','--env-file',str(ROOT/'.env.deploy'),'-f',str(ROOT/'compose.yaml')]

def health():
    for _ in range(45):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8787/api/health',timeout=3) as r:
                if json.load(r).get('ok'):return
        except Exception:pass
        time.sleep(1)
    raise RuntimeError('BACKEND_NOT_HEALTHY')

def connection():
    sys.path.insert(0,'/home/ubuntu/seatraces-osm/.deps');import psycopg
    config=json.loads(Path('/home/ubuntu/seatraces-osm/database.json').read_text())
    config.pop('database',None);config['dbname']='seatraces_business'
    return psycopg.connect(**config,connect_timeout=8)

def api(path,*,cookie='',body=None,expected=200):
    req=urllib.request.Request('http://127.0.0.1:8787/api'+path,
      data=json.dumps(body).encode() if body is not None else None,
      headers={'Content-Type':'application/json','X-Seatraces':'1','Cookie':cookie})
    try:
        with urllib.request.urlopen(req,timeout=30) as r:status,data=r.status,json.load(r)
    except urllib.error.HTTPError as e:status,data=e.code,json.load(e)
    if status!=expected:raise RuntimeError('ACCEPTANCE_HTTP_STATUS_FAILED')
    return data

def cleanup(fixtures):
    with connection() as db:
        for u in fixtures['users']:
            found=db.execute('SELECT username FROM users WHERE id=%s',(u['id'],)).fetchone()
            if not found:continue
            if found[0]!=u['username'] or not found[0].startswith('capqa_'):raise RuntimeError('FIXTURE_IDENTITY_MISMATCH')
            db.execute('DELETE FROM audit_log WHERE user_id=%s',(u['id'],))
            db.execute('DELETE FROM operation_events WHERE user_id=%s',(u['id'],))
            db.execute('DELETE FROM users WHERE id=%s',(u['id'],))
        for table in ('city_weather_cache','city_weather_alerts'):
            db.execute('DELETE FROM '+table+' WHERE city_key=%s',(fixtures['cityKey'],))

def provision():
    import secrets
    batch=uuid.uuid4().hex[:12];users=[{'id':str(uuid.uuid4()),'username':'capqa_'+batch+'_'+s,'token':secrets.token_hex(32)} for s in ('a','b')]
    fixtures={'users':users,'trip':str(uuid.uuid4()),'cityKey':'capqa_'+batch}
    with connection() as db:
        for u in users:
            db.execute("INSERT INTO users(id,username,password_hash,nickname,analytics_excluded) VALUES(%s,%s,'!','功能验收临时账号',true)",(u['id'],u['username']))
            db.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(%s,%s,now()+interval '15 minutes')",(hashlib.sha256(u['token'].encode()).hexdigest(),u['id']))
        city={'id':fixtures['cityKey'],'name':'上海','country':'CN','lat':31.23,'lng':121.47,'adcode':'310101'}
        today=time.strftime('%Y-%m-%d',time.gmtime(time.time()+8*3600))
        plan={'schemaVersion':'journey/2','cities':[city],'days':[{'cityId':city['id'],'date':today,'stops':[]},{'cityId':city['id'],'date':'2099-01-01','stops':[]}],'releaseTestData':True}
        db.execute("INSERT INTO trips(id,user_id,title,request,plan) VALUES(%s,%s,'功能验收临时行程','{}',%s)",(fixtures['trip'],users[0]['id'],json.dumps(plan)))
    # Independent cleanup after expiry also covers a worker crash.
    directory=Path('/var/lib/seatraces/place-weather');file=directory/('fixture-'+batch+'.json')
    save(file,json.dumps(fixtures).encode())
    subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--cleanup',str(file)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    return fixtures

def valid_cleanup_file(file):
    return file.parent==Path('/var/lib/seatraces/place-weather') and bool(re.fullmatch('fixture-[a-f0-9]{12}[.]json',file.name))

def acceptance():
    fixtures=provision();cookie='st_session='+fixtures['users'][0]['token'];other='st_session='+fixtures['users'][1]['token']
    query={'q':'衢州孔庙','city':'衢州','countryCode':'CN','lat':28.96,'lng':118.875,'radius':3000,'category':'scenic','intent':'named','fallback':'never'}
    try:
        api('/catalog/candidates',body=query,expected=401)
        api('/catalog/candidates',cookie=cookie,body={**query,'radius':-1},expected=400)
        started=time.monotonic();result=api('/catalog/candidates',cookie=cookie,body=query)
        if result.get('selection',{}).get('resolvedName')!='孔氏南宗家庙' or result.get('fallback',{}).get('requests')!=0:raise RuntimeError('SEMANTIC_RECALL_FAILED')
        score=result['items'][0]['match']['semanticSimilarity']
        if not isinstance(score,(float,int)) or score<0.65:raise RuntimeError('SEMANTIC_SCORE_FAILED')
        semantic={'name':result['selection']['resolvedName'],'cosine':score,'elapsedMs':round((time.monotonic()-started)*1000),
                  'stages':[{'stage':v['stage'],'status':v['status']} for v in result['embedding']],'identityVerified':False}
        path='/journey/trips/'+fixtures['trip']+'/weather'
        api(path,expected=401);api(path,cookie=other,expected=404);api(path+'?day=30',cookie=cookie,expected=400)
        started=time.monotonic();weather=api(path,cookie=cookie)
        if weather.get('status')!='available' or not weather.get('forecast') or weather.get('provider')!='amap':raise RuntimeError('WEATHER_FORECAST_FAILED')
        if api(path+'?day=1',cookie=cookie).get('status')!='outside_forecast_range':raise RuntimeError('WEATHER_DATE_GUARD_FAILED')
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            repeated=list(pool.map(lambda _:api(path,cookie=cookie),range(12)))
        if any(v.get('reportedAt')!=weather.get('reportedAt') for v in repeated):raise RuntimeError('WEATHER_CACHE_FAILED')
        warnings=api(path.replace('/weather','/weather-alerts'),cookie=cookie)
        return {'semantic':semantic,'weather':{'provider':'amap','date':weather['forecast']['date'],'reportedAt':weather.get('reportedAt'),
          'elapsedMs':round((time.monotonic()-started)*1000),'cachedRequests':12},'officialAlerts':warnings.get('status'),
          'permissions':'anonymous 401, other owner 404, invalid parameters 400','modelDownloads':0,'llmCalls':0,'maxWeatherProviderCalls':1}
    finally:
        # Allow the normal one-second audit buffer to flush before deleting only
        # these two temporary identities. No formal-user rows are touched.
        time.sleep(2);cleanup(fixtures)

def backend_state():
    raw=run(['docker','inspect','seatraces-business-backend-1','--format','{{json .State}}']).decode()
    state=json.loads(raw)
    return {'pid':state['Pid'],'startedAt':state['StartedAt'],'oom':state['OOMKilled']}

def activate():
    import fcntl
    with (STATE/'deploy.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        image=run(['docker','inspect','seatraces-business-backend-1','--format','{{.Config.Image}}']).decode().strip()
        if image!='seatraces-business:git-'+COMMIT[:12]:raise RuntimeError('REVIEWED_IMAGE_CHANGED')
        for name,sha in MODEL_FILES.items():
            path=ROOT/'cache/models/bge-small-zh-v1.5'/name
            if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=sha:raise RuntimeError('PINNED_MODEL_CHECK_FAILED')
        # Inspect booleans only, never print keys or the server environment.
        config=json.loads(run(['docker','exec','seatraces-business-backend-1','node','-e',"console.log(JSON.stringify({amap:!!process.env.AMAP_KEY,semantic:process.env.EMBEDDING_ENABLED==='true'}))"]))
        if not config.get('amap'):raise RuntimeError('EXISTING_AMAP_KEY_MISSING')
        with connection() as db:
            for table in ('city_weather_cache','city_weather_alerts'):db.execute('SELECT * FROM '+table+' LIMIT 0')
        env=ROOT/'backend.env'
        if env.is_symlink():raise RuntimeError('UNEXPECTED_ENV_LINK')
        old=env.read_bytes();updated=enabled_env(old)
        backup=ROOT/'backups'/('backend-before-place-weather-'+str(time.time_ns())+'.env');save(backup,old)
        report('activating',configurationBackup=str(backup),existingPinnedModelVerified=True)
        changed=False;stop=threading.Event();samples=[];thread=None
        try:
            save(env,updated);changed=True
            run(compose()+['up','-d','--force-recreate','backend'],timeout=120);health()
            before=backend_state()
            def sample():
                while not stop.is_set():
                    try:
                        text=Path('/proc/'+str(before['pid'])+'/status').read_text()
                        samples.append(int(re.search(r'^VmRSS:\s+(\d+)',text,re.M).group(1)))
                    except Exception:pass
                    stop.wait(.1)
            thread=threading.Thread(target=sample,daemon=True);thread.start()
            report('verifying',configurationBackup=str(backup));result=acceptance()
            after=backend_state()
            if before['startedAt']!=after['startedAt'] or after['oom']:raise RuntimeError('BACKEND_RESTARTED_DURING_ACCEPTANCE')
            if not samples:raise RuntimeError('MEMORY_SAMPLING_FAILED')
            peak=round(max(samples,default=0)/1024)
            if peak>=560:raise RuntimeError('BACKEND_MEMORY_MARGIN_TOO_SMALL')
            with connection() as db:
                metadata={'placeSemanticEnabled':True,'weatherProvider':'amap','passed':True,'officialAlerts':result['officialAlerts'],'backendPeakRssMiB':peak,'temporaryAccountsRemoved':True}
                event=db.execute("INSERT INTO operation_events(kind,action,metadata) VALUES('system','capabilities.place_weather.activated',%s) RETURNING id",(json.dumps(metadata),)).fetchone()[0]
            report('completed',configurationBackup=str(backup),verification=result,backendPeakRssMiB=peak,
                   backendRestartedDuringAcceptance=False,temporaryAccountsRemoved=True,auditRecorded=True,auditId=str(event),newCredentials=False)
        except Exception as e:
            code=str(e) if isinstance(e,RuntimeError) and re.fullmatch('[A-Z_]+',str(e)) else 'CAPABILITY_ACTIVATION_FAILED'
            if changed:
                if env.read_bytes()!=updated:raise RuntimeError('ENV_CHANGED_DURING_ROLLBACK') from None
                try:save(env,old);run(compose()+['up','-d','--force-recreate','backend'],timeout=120);health();report('rolled_back',error=code,configurationBackup=str(backup))
                except Exception:report('rollback_failed',error=code,configurationBackup=str(backup))
            else:report('failed',error=code)
        finally:
            stop.set()
            if thread:thread.join(timeout=2)

def setup():
    import fcntl
    if os.geteuid()!=0:raise RuntimeError('ROOT_REQUIRED')
    directory=Path('/var/lib/seatraces/place-weather');directory.mkdir(mode=0o700,exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid!=0 or directory.stat().st_mode&0o077:raise RuntimeError('PRIVATE_DIRECTORY_MISMATCH')
    with (directory/'start.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        launch(directory)

def launch(directory):
    record=json.loads((STATE/(COMMIT+'.json')).read_text())
    if record.get('placeWeatherActivation',{}).get('phase')=='completed':
        print(json.dumps(record['placeWeatherActivation']));return
    current=directory/'current.json'
    if current.exists():
        pid=json.loads(current.read_text()).get('pid',0)
        try:
            if b'activate-place-weather.py' in Path('/proc/'+str(pid)+'/cmdline').read_bytes():raise RuntimeError('ALREADY_RUNNING')
        except OSError:pass
    target=directory/'activate-place-weather.py';save(target,Path(__file__).read_bytes())
    with (directory/'activation.log').open('ab') as out:
        os.fchmod(out.fileno(),0o600)
        child=subprocess.Popen([sys.executable,str(target),'--run'],stdin=subprocess.DEVNULL,stdout=out,stderr=out,start_new_session=True)
    save(current,json.dumps({'pid':child.pid,'commit':COMMIT}).encode())
    print(json.dumps({'started':True,'pid':child.pid,'commit':COMMIT,'newCredentials':False,'schemaChanges':False,'status':str(STATE/(COMMIT+'.json'))}))

if __name__=='__main__':
    try:
        if sys.argv[1:]==['--run']:activate()
        elif len(sys.argv)==3 and sys.argv[1]=='--cleanup':
            file=Path(sys.argv[2])
            if not valid_cleanup_file(file):raise RuntimeError('INVALID_CLEANUP_PATH')
            time.sleep(920);cleanup(json.loads(file.read_text()))
        elif len(sys.argv)==1:setup()
        else:raise RuntimeError('INVALID_INVOCATION')
    except Exception as e:
        code=str(e) if isinstance(e,RuntimeError) and re.fullmatch('[A-Z_]+',str(e)) else 'CAPABILITY_SETUP_FAILED'
        try:report('failed',error=code)
        except Exception:print(json.dumps({'phase':'failed','error':code}))
        sys.exit(1)
