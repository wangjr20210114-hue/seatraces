"""更新腾讯云邮件配置并检查服务状态。"""
from pathlib import Path
import base64,hashlib,json,os,re,subprocess,sys,time,urllib.request

COMMIT='c7de59ddaa474eb67452182e0de1f8aa4f658fad'
ROOT=Path('/home/ubuntu/seatraces-app')
STATE=Path('/var/lib/seatraces/git-deploy')
FIELDS={'MAIL_PROVIDER':'tencent_ses','APP_ORIGIN':'https://trip.seatraces.com',
 'SES_REGION':'ap-guangzhou','SES_FROM':'noreply@notify.seatraces.com',
 'SES_TEMPLATE_VERIFY_EMAIL':'64137','SES_TEMPLATE_RESET_PASSWORD':'64138','SES_TEMPLATE_PASSWORD_CHANGED':'64139'}

def run(args,*,data=None,timeout=60):
    r=subprocess.run(args,input=data,capture_output=True,timeout=timeout)
    if r.returncode:raise RuntimeError('SERVER_COMMAND_FAILED')
    return r.stdout

def private_write(p,data):
    if p.is_symlink():raise RuntimeError('UNEXPECTED_FILE_LINK')
    temporary=p.with_name(p.name+'.mail-next-'+str(os.getpid()))
    with temporary.open('xb') as out:os.fchmod(out.fileno(),0o600);out.write(data)
    temporary.replace(p)

def merged_env(old,updates):
    pattern=re.compile(r'^\s*(?:export\s+)?('+'|'.join(re.escape(k) for k in updates)+r')\s*=')
    lines=[s for s in old.splitlines() if not pattern.match(s)]
    return '\n'.join(lines+['']+[k+'='+v for k,v in updates.items()])+'\n'

def report(phase,**kwargs):
    p=STATE/(COMMIT+'.json');value=json.loads(p.read_text())
    if value.get('phase')!='completed' or value.get('commit')!=COMMIT:raise RuntimeError('RELEASE_NOT_COMPLETED')
    activation={'phase':phase,'updatedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
                'messageSent':False,**kwargs}
    value['mailActivation']=activation
    private_write(p,json.dumps(value,indent=2).encode())
    print(json.dumps(activation),flush=True)

def compose():return ['docker','compose','--env-file',str(ROOT/'.env.deploy'),'-f',str(ROOT/'compose.yaml')]

VERIFY_SCRIPT="""import {mailConfiguration} from './server/services/mail-outbox.mjs';
import {createMailer} from './server/mail.mjs';
const configuration=mailConfiguration(),result={configuration,verification:'not_configured',messageSent:false};
if(!configuration.enabled)process.exitCode=1;
else try{result.checks=await createMailer().verify();result.verification='ses_domain_and_templates_passed';}
catch(e){result.verification='ses_configuration_verification_failed';if(/^SES_[A-Z_]+$/.test(e?.mailDelivery?.code))result.errorCode=e.mailDelivery.code;process.exitCode=1;}
console.log(JSON.stringify(result));"""

def check_mail(preflight=False):
    args=(compose()+['run','--rm','--no-deps','-T','--entrypoint','node','backend','--input-type=module','-e',VERIFY_SCRIPT]
          if preflight else ['docker','exec','seatraces-business-backend-1','node','--input-type=module','-e',VERIFY_SCRIPT])
    r=subprocess.run(args,capture_output=True,timeout=90)
    try:v=json.loads(r.stdout)
    except Exception:raise RuntimeError('MAIL_VERIFICATION_FAILED') from None
    if r.returncode or v.get('verification')!='ses_domain_and_templates_passed':
        code=v.get('errorCode','MAIL_VERIFICATION_FAILED')
        raise RuntimeError(code if re.fullmatch(r'SES_[A-Z_]+',code) else 'MAIL_VERIFICATION_FAILED')
    if v.get('messageSent') is not False or not v.get('configuration',{}).get('enabled'):raise RuntimeError('MAIL_NOT_ENABLED')

def health():
    for attempt in range(45):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8787/api/health',timeout=3) as r:
                if json.load(r).get('ok'):return
        except Exception:pass
        time.sleep(1)
    raise RuntimeError('BACKEND_NOT_HEALTHY')

def record_activation():
    code="""import {pool} from './server/db.mjs';
const metadata=JSON.parse(await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s));}));
try{const q=await pool.query("INSERT INTO operation_events(kind,action,metadata) VALUES('system','mail.configuration.activated',$1) RETURNING id,created_at",[metadata]);console.log(JSON.stringify(q.rows[0]));}finally{await pool.end();}"""
    metadata={'provider':'tencent_ses','passed':True,'domainVerified':True,'templatesApproved':True,
              'templateIds':{'verify_email':64137,'reset_password':64138,'password_changed':64139},
              'commit':COMMIT,'messageSent':False}
    return json.loads(run(['docker','exec','-i','seatraces-business-backend-1','node','--input-type=module','-e',code],data=json.dumps(metadata).encode()))

def main():
    import fcntl
    if os.geteuid()!=0:raise RuntimeError('ROOT_REQUIRED')
    try:credentials=json.loads(sys.stdin.read())
    except Exception:raise RuntimeError('INVALID_CREDENTIAL_FIELDS') from None
    if set(credentials)!={'SES_SECRET_ID','SES_SECRET_KEY'}:raise RuntimeError('INVALID_CREDENTIAL_FIELDS')
    with (STATE/'deploy.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        return activate(credentials)

def activate(credentials):
    release=json.loads((STATE/(COMMIT+'.json')).read_text())
    if release.get('phase')!='completed':raise RuntimeError('RELEASE_NOT_COMPLETED')
    active=run(['docker','inspect','seatraces-business-backend-1','--format','{{.Config.Image}}']).decode().strip()
    if active!=release.get('image') or active!='seatraces-business:git-'+COMMIT[:12]:raise RuntimeError('ACTIVE_RELEASE_CHANGED')
    label=run(['docker','image','inspect',active,'--format','{{index .Config.Labels "org.opencontainers.image.revision"}}']).decode().strip()
    if label!=COMMIT:raise RuntimeError('ACTIVE_REVISION_CHANGED')
    env_path=ROOT/'backend.env'
    if env_path.is_symlink() or not env_path.is_file():raise RuntimeError('UNEXPECTED_ENV_FILE')
    old=env_path.read_bytes();old_hash=hashlib.sha256(old).hexdigest()
    parse_key="""import {parse} from 'dotenv';let s='';for await(const c of process.stdin)s+=c;
console.log(JSON.stringify({oldQueueKey:parse(s).MAIL_OUTBOX_KEY||''}));"""
    try:existing=json.loads(run(['docker','run','--rm','-i','--network','none','--entrypoint','node',active,'--input-type=module','-e',parse_key],
                         data=old,timeout=30))
    except Exception:raise RuntimeError('ENV_PARSE_FAILED') from None
    values={**credentials,**existing}
    if set(values)!={'SES_SECRET_ID','SES_SECRET_KEY','oldQueueKey'}:raise RuntimeError('INVALID_CREDENTIAL_FIELDS')
    for k in ('SES_SECRET_ID','SES_SECRET_KEY'):
        if not isinstance(values[k],str) or not re.fullmatch(r'[A-Za-z0-9_+=/.-]{8,256}',values[k]):raise RuntimeError('INVALID_CREDENTIAL_FORMAT')
    queue_key=values.pop('oldQueueKey') or base64.b64encode(os.urandom(32)).decode()
    try:
        if len(base64.b64decode(queue_key,validate=True))!=32:raise ValueError()
    except Exception:raise RuntimeError('EXISTING_QUEUE_KEY_INVALID') from None
    updates={**FIELDS,**values,'MAIL_OUTBOX_KEY':queue_key}
    updated=merged_env(old.decode('utf8'),updates).encode()
    backup=ROOT/'backups'/('backend-before-ses-'+str(time.time_ns())+'.env')
    with backup.open('xb') as out:os.fchmod(out.fileno(),0o600);out.write(old)
    report('configuring',configurationBackup=str(backup))
    changed=False
    try:
        if hashlib.sha256(env_path.read_bytes()).hexdigest()!=old_hash:raise RuntimeError('ENV_CHANGED_CONCURRENTLY')
        private_write(env_path,updated);changed=True
        check_mail(preflight=True)
        report('recreating_backend',configurationBackup=str(backup))
        run(compose()+['up','-d','--force-recreate','backend'],timeout=120)
        health();check_mail()
        with urllib.request.urlopen('http://127.0.0.1:8787/api/auth/config',timeout=5) as r:
            if json.load(r).get('emailEnabled') is not True:raise RuntimeError('PUBLIC_MAIL_FLOW_DISABLED')
        event=record_activation()
        report('completed',configurationBackup=str(backup),provider='tencent_ses',
               domainVerified=True,templatesApproved=True,backendEmailEnabled=True,auditRecorded=True,
               auditId=event['id'],newCredentials=False,permissionsChanged=False)
    except Exception as error:
        safe=str(error) if isinstance(error,RuntimeError) and re.fullmatch('[A-Z_]+',str(error)) else 'MAIL_ACTIVATION_FAILED'
        if changed:
            if env_path.read_bytes()!=updated:raise RuntimeError('ENV_CHANGED_DURING_ROLLBACK') from None
            try:
                private_write(env_path,old);run(compose()+['up','-d','--force-recreate','backend'],timeout=120);health()
                report('rolled_back',error=safe,configurationBackup=str(backup))
            except Exception:
                report('rollback_failed',error=safe,configurationBackup=str(backup));return
        else:report('failed',error=safe,configurationBackup=str(backup))


def setup():
    import fcntl,getpass
    if os.geteuid()!=0:raise SystemExit('Run with sudo')
    record=json.loads((STATE/(COMMIT+'.json')).read_text())
    if record.get('phase')!='completed':raise SystemExit('Code deployment not completed')
    if record.get('mailActivation',{}).get('phase')=='completed':raise SystemExit('Mail already activated; inspect backend status')
    base=Path('/var/lib/seatraces/mail-config');base.mkdir(mode=0o700,exist_ok=True)
    if base.is_symlink() or base.stat().st_uid!=0 or base.stat().st_mode&0o077:raise SystemExit('Private directory mismatch')
    with (base/'setup.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        current=base/'current.json'
        if current.exists():
            previous=json.loads(current.read_text());pid=previous.get('pid',0)
            try:
                if b'configure-mail.py' in Path('/proc/'+str(pid)+'/cmdline').read_bytes():raise SystemExit('Mail setup is already running')
            except OSError:pass
        credentials={}
        for name in ('SES_SECRET_ID','SES_SECRET_KEY'):
            credentials[name]=getpass.getpass(name+' (hidden): ').strip()
            if not re.fullmatch(r'[A-Za-z0-9_+=/.-]{8,256}',credentials[name]):raise SystemExit('Invalid input; nothing changed')
        path=base/'configure-mail.py'
        if path.is_symlink():raise SystemExit('Unexpected file link')
        raw=Path(__file__).read_bytes()
        with path.open('wb') as out:os.fchmod(out.fileno(),0o600);out.write(raw)
        with (base/'setup.log').open('ab') as log:
            os.fchmod(log.fileno(),0o600)
            child=subprocess.Popen([sys.executable,str(path),'--worker'],stdin=subprocess.PIPE,stdout=log,stderr=log,start_new_session=True)
            child.stdin.write(json.dumps(credentials).encode());child.stdin.close();credentials.clear()
        with current.open('w') as out:os.fchmod(out.fileno(),0o600);json.dump({'pid':child.pid,'commit':COMMIT},out)
        print(json.dumps({'started':True,'pid':child.pid,'commit':COMMIT,'messageSent':False,'newSshCredentials':False}))
if __name__=='__main__':
    try:
        if sys.argv[1:]==['--worker']:main()
        elif sys.argv[1:]==[]:setup()
        else:raise RuntimeError('INVALID_INVOCATION')
    except Exception as error:
        code=str(error) if isinstance(error,RuntimeError) and re.fullmatch('[A-Z_]+',str(error)) else 'MAIL_SETUP_FAILED'
        try:report('failed',error=code)
        except Exception:print(json.dumps({'phase':'failed','error':code}),flush=True)
        sys.exit(1)
