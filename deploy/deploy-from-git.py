"""从指定 Git 版本构建并部署服务，处理健康检查和回退。"""
from pathlib import Path,PurePosixPath
import argparse,fcntl,hashlib,io,json,os,re,subprocess,sys,tarfile,time,urllib.request,urllib.error

ROOT=Path('/home/ubuntu/seatraces-app')
SOURCE=Path('/srv/seatraces')
STATE=Path('/var/lib/seatraces/git-deploy')
REMOTE='https://github.com/wangjr20210114-hue/seatraces.git'

class GitFailure(RuntimeError):
    def __init__(self,operation,detail,transient=False):
        super().__init__('Git '+operation+' failed: '+detail)
        self.transient=transient

def git_failure(operation,stderr,code):
    detail=(stderr.decode('utf8',errors='replace') if isinstance(stderr,bytes) else stderr or '').strip()
    lower=detail.lower()
    transient=any(value in lower for value in ('could not resolve host','failed to connect','timed out','too slow',
                  'gnutls_handshake','tls connection','ssl_connect','connection reset','rpc failed','early eof','remote end hung up'))
    detail=re.sub(r'(https?://)[^\s/@]+:[^\s/@]+@',r'\1[redacted]@',detail)
    detail=re.sub(r'\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b','[redacted]',detail)
    detail=re.sub(r'-----BEGIN [\s\S]*?-----END [^\n]+-----','[redacted]',detail)
    detail=re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',detail)
    return GitFailure(operation,'exit '+str(code)+'; '+detail[-800:],transient)

def command(argv,**kwargs):
    result=subprocess.run(argv,check=True,**kwargs)
    return result.stdout

def git(*args,binary=False):
    env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
    env.update(HOME='/home/seatraces_dev',XDG_CONFIG_HOME='/home/seatraces_dev/.config',GIT_TERMINAL_PROMPT='0')
    try:
        return command(['runuser','-u','seatraces_dev','--','git','-c','core.hooksPath=/dev/null',
                        '-c','core.fsmonitor=false','-c','credential.helper=','-c','protocol.ext.allow=never','-C',str(SOURCE),*args],
                       env=env,capture_output=True,text=not binary,timeout=180)
    except subprocess.CalledProcessError as error:
        raise git_failure(args[0],error.stderr,error.returncode) from None
    except subprocess.TimeoutExpired:
        raise GitFailure(args[0],'exceeded 180 seconds; inspect server Git/network state before retrying') from None

def save(path,data):
    temporary=path.with_suffix('.next-'+str(os.getpid()))
    with temporary.open('x') as out:
        os.fchmod(out.fileno(),0o600);json.dump(data,out,ensure_ascii=False,indent=2)
    temporary.replace(path)

def schema_tree(commit):
    entries=git('ls-tree','-r',commit,'--','server').splitlines()
    return sorted(line for line in entries if line.endswith('.sql'))

def unpack(raw,destination):
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for member in archive.getmembers():
            rel=PurePosixPath(member.name)
            if rel.is_absolute() or '..' in rel.parts or not (member.isfile() or member.isdir()):
                raise RuntimeError('Release archive contains unsupported paths or links')
            if member.name.startswith(('.git/','.runtime/','node_modules/')) or member.name in ('.env','backend.env','.env.deploy'):
                raise RuntimeError('Release archive contains private runtime files')
        archive.extractall(destination)

def deploy(commit):
    lock=(STATE/'deploy.lock').open('a')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:return
    record=STATE/(commit+'.json')
    previous={};activated=False;old_env=None;updated_env=None;progress='starting'
    def report(phase,**extra):
        nonlocal progress
        progress=phase
        value={'commit':commit,'phase':phase,'pid':os.getpid(),'updatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),**extra}
        save(record,value);print(json.dumps(value),flush=True)
    try:
        policy=json.loads((STATE/'policy.json').read_text())
        if SOURCE.resolve()!=Path(policy['source']):raise RuntimeError('Shared source target changed')
        if git('remote','get-url','origin').strip()!=REMOTE:raise RuntimeError('Unexpected Git remote')
        if git('branch','--show-current').strip()!='main':raise RuntimeError('Server shared source must be on main')
        if git('status','--porcelain','--untracked-files=normal').strip():raise RuntimeError('Server has local changes; save and resolve them before deployment')
        for attempt in range(1,4):
            report('fetching',attempt=attempt)
            try:
                git('fetch','origin','main');break
            except GitFailure as error:
                if not error.transient or attempt==3:raise
                report('retrying_fetch',attempt=attempt,error=str(error))
                time.sleep(3)
        if git('rev-parse','origin/main').strip()!=commit:raise RuntimeError('Requested commit is not the current origin/main tip')
        old_env=(ROOT/'.env.deploy').read_text()
        old_image=re.search(r'^SEATRACES_IMAGE=(.+)$',old_env,re.M).group(1)
        active=command(['docker','inspect','seatraces-business-backend-1','--format','{{.Config.Image}}'],capture_output=True,text=True).strip()
        if active!=old_image:raise RuntimeError('Running and configured images differ')
        candidates=[]
        label=command(['docker','image','inspect',active,'--format','{{index .Config.Labels "org.opencontainers.image.revision"}}'],capture_output=True,text=True).strip()
        if re.fullmatch('[a-f0-9]{40}',label):candidates.append(label)
        for p in [*(ROOT.glob('*update-status.json')),*(STATE.glob('*.json'))]:
            try:v=json.loads(p.read_text())
            except (ValueError,OSError):continue
            if v.get('phase')=='completed' and v.get('image')==active and re.fullmatch('[a-f0-9]{40}',v.get('commit','')):candidates.append(v['commit'])
        if len(set(candidates))!=1:raise RuntimeError('Cannot identify the currently deployed Git commit')
        prior_commit=candidates[0]
        if schema_tree(prior_commit)!=schema_tree(commit):
            raise RuntimeError('Database SQL changed: a reviewed migration is required before automatic deployment')
        for name,expected in policy['buildFiles'].items():
            content=git('show',commit+':'+name,binary=True)
            if hashlib.sha256(content).hexdigest()!=expected:raise RuntimeError('Build policy changed; administrator must review '+name)
        report('updating_source')
        git('merge','--ff-only',commit)
        if git('rev-parse','HEAD').strip()!=commit:raise RuntimeError('main moved during pull; deployment stopped')
        stage=ROOT/'incoming'/('git-'+commit[:12]+'-'+str(time.time_ns()))
        stage.mkdir(mode=0o700)
        checkout=stage/'checkout';checkout.mkdir()
        unpack(git('archive','--format=tar',commit,binary=True),checkout)
        image='seatraces-business:git-'+commit[:12]
        report('building',image=image,previousImage=old_image)
        with (stage/'build.log').open('w') as log:
            command(['docker','build','--label','org.opencontainers.image.revision='+commit,'-t',image,str(checkout)],stdout=log,stderr=log,timeout=900)
        for name in ('server/index.mjs','server/frontend.mjs','public/journey.js'):
            command(['docker','run','--rm','--network','none','--entrypoint','node',image,'--check','/app/'+name],stdout=subprocess.DEVNULL,timeout=30)
        if (ROOT/'.env.deploy').read_text()!=old_env:raise RuntimeError('Another deployment changed the active image')
        report('backing_up',image=image)
        cfg=json.loads(Path('/home/ubuntu/seatraces-osm/database.json').read_text())
        backup=ROOT/'backups'/('business-before-git-'+commit[:12]+'-'+str(time.time_ns())+'.dump')
        with backup.open('xb') as stream:
            os.fchmod(stream.fileno(),0o600)
            command(['docker','exec','seatraces-osm-db','pg_dump','-U',cfg['user'],'-d','seatraces_business','-Fc'],stdout=stream,timeout=180)
        with backup.open('rb') as stream:
            command(['docker','exec','-i','seatraces-osm-db','pg_restore','--list'],stdin=stream,stdout=subprocess.DEVNULL,timeout=60)
        previous={'previousImage':old_image,'backup':str(backup),'sourceCommit':commit}
        compose=['docker','compose','--env-file',str(ROOT/'.env.deploy'),'-f',str(ROOT/'compose.yaml')]
        updated_env=re.sub(r'^SEATRACES_IMAGE=.+$','SEATRACES_IMAGE='+image,old_env,flags=re.M)
        report('activating',image=image,**previous)
        activated=True
        write_env(updated_env)
        command(compose+['up','-d','backend','frontend'],timeout=120)
        for attempt in range(45):
            try:
                with urllib.request.urlopen('http://127.0.0.1:8787/api/health',timeout=3) as response:
                    if json.load(response).get('ok'):break
            except Exception:pass
            time.sleep(1)
        else:raise RuntimeError('Backend health check failed')
        gateway=re.search(r'^CADDY_BRIDGE_GATEWAY=(.+)$',old_env,re.M).group(1)
        with urllib.request.urlopen('http://'+gateway+':8788/frontend-health',timeout=8) as response:
            if json.load(response).get('service')!='seatraces-frontend':raise RuntimeError('Frontend check failed')
        for name in ('journey.js','agent-page.js','discovery.js'):
            with urllib.request.urlopen('http://'+gateway+':8788/'+name,timeout=8) as response:
                if hashlib.sha256(response.read()).digest()!=hashlib.sha256((checkout/'public'/name).read_bytes()).digest():raise RuntimeError('Frontend version differs: '+name)
        try:urllib.request.urlopen('http://127.0.0.1:8787/api/agent/capabilities',timeout=8)
        except urllib.error.HTTPError as error:
            if error.code!=401:raise RuntimeError('Authentication check failed')
        else:raise RuntimeError('Anonymous authenticated API request was accepted')
        report('completed',image=image,url='https://trip.seatraces.com',**previous)
    except Exception as error:
        phase='failed'
        if activated:
            try:
                if (ROOT/'.env.deploy').read_text()!=updated_env:raise RuntimeError('Another deployment changed the image')
                write_env(old_env);command(compose+['up','-d','backend','frontend'],timeout=120)
                for attempt in range(45):
                    try:
                        with urllib.request.urlopen('http://127.0.0.1:8787/api/health',timeout=3) as response:
                            if json.load(response).get('ok'):break
                    except Exception:pass
                    time.sleep(1)
                else:raise RuntimeError('Previous image did not become healthy')
                phase='rolled_back'
            except Exception:phase='rollback_failed'
        detail=str(error) if isinstance(error,RuntimeError) else type(error).__name__
        if isinstance(error,subprocess.CalledProcessError):detail='Command failed with exit '+str(error.returncode)+' during '+progress
        report(phase,error=detail,failedPhase=progress,**previous)

def write_env(contents):
    next_file=ROOT/'.env.deploy.git-next'
    with next_file.open('w') as stream:os.fchmod(stream.fileno(),0o600);stream.write(contents)
    next_file.replace(ROOT/'.env.deploy')

def gateway(request):
    if request=='check':
        policy=json.loads((STATE/'policy.json').read_text())
        if SOURCE.resolve()!=Path(policy['source']) or git('remote','get-url','origin').strip()!=REMOTE:
            raise RuntimeError('Shared source or remote changed')
        print(json.dumps({'ok':True,'protocol':'seatraces-git-deploy/1','source':str(SOURCE),'branch':git('branch','--show-current').strip(),
                          'clean':not bool(git('status','--porcelain','--untracked-files=normal').strip()),'remote':REMOTE,
                          'gatewaySha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}));return
    match=re.fullmatch(r'(deploy|status) ([a-f0-9]{40})',request)
    if not match:raise RuntimeError('Only check, deploy <main commit>, status <commit> are allowed')
    action,commit=match.groups();record=STATE/(commit+'.json')
    if action=='status':
        print(record.read_text() if record.exists() else json.dumps({'phase':'not_started','commit':commit}));return
    with (STATE/'start.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        queue_deploy(commit,record)

def queue_deploy(commit,record):
    current=STATE/'current.json'
    if current.exists():
        value=json.loads(current.read_text());pid=value.get('pid',0)
        try:
            running=Path('/proc/'+str(pid)+'/cmdline').read_bytes()
            if b'deploy-from-git.py' in running and b'--run' in running:
                if value.get('commit')!=commit:raise RuntimeError('Another deployment is running')
                print(record.read_text());return
        except OSError:pass
    if record.exists():
        value=json.loads(record.read_text());pid=value.get('pid',0)
        if value.get('phase') not in ('failed','rolled_back','rollback_failed','completed') and pid:
            try:
                if b'deploy-from-git.py' in Path('/proc/'+str(pid)+'/cmdline').read_bytes():print(json.dumps(value));return
            except OSError:pass
    with (STATE/'deploy.lock').open('a') as busy:
        try:fcntl.flock(busy,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('Another deployment is running')
    save(record,{'phase':'queued','commit':commit,'pid':0})
    with (STATE/(commit+'.log')).open('ab') as log:
        os.fchmod(log.fileno(),0o600)
        child=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--run',commit],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    value={'phase':'queued','commit':commit,'pid':child.pid}
    save(current,value)
    print(json.dumps(value))

if __name__=='__main__':
    parser=argparse.ArgumentParser();group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--request');group.add_argument('--run');args=parser.parse_args()
    if os.geteuid()!=0:raise SystemExit('Root-owned gateway required')
    try:
        if args.run:
            if not re.fullmatch('[a-f0-9]{40}',args.run):raise RuntimeError('Invalid commit')
            deploy(args.run)
        else:gateway(args.request)
    except Exception as error:
        print(json.dumps({'error':str(error) if isinstance(error,RuntimeError) else type(error).__name__}));raise SystemExit(1)
