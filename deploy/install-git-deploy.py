"""One-time administrator installation, executed only after deployment-key approval.

The prepared launcher provides PAYLOAD containing reviewed gateway code and public key.
"""
from pathlib import Path
import base64,hashlib,json,os,pwd,re,subprocess,time

ROOT=Path('/home/ubuntu/seatraces-app')
STATE=Path('/var/lib/seatraces/git-deploy')
LIB=Path('/usr/local/lib/seatraces')
MARKER='seatraces-local-git-deploy'
EXPECTED_REMOTE='https://github.com/wangjr20210114-hue/seatraces.git'

def main(payload):
    if os.geteuid()!=0:raise SystemExit('Run with sudo python3')
    account=pwd.getpwnam('ubuntu')
    pwd.getpwnam('seatraces_dev')
    git_command=['runuser','-u','seatraces_dev','--','git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C','/srv/seatraces']
    def git(*args):
        return subprocess.check_output([*git_command,*args],text=True).strip()
    source=Path('/srv/seatraces').resolve(strict=True)
    if git('remote','get-url','origin')!=EXPECTED_REMOTE:raise RuntimeError('Unexpected shared-source remote')
    if git('branch','--show-current')!='main':raise RuntimeError('Switch the shared source to main first')
    if git('status','--porcelain','--untracked-files=normal'):raise RuntimeError('Commit or preserve server changes before installing')
    if not (ROOT/'compose.yaml').is_file() or not (ROOT/'.env.deploy').is_file():raise RuntimeError('Existing deployment not found')
    key=payload['publicKey'].split()
    if len(key)<2 or key[0]!='ssh-ed25519':raise RuntimeError('Expected an Ed25519 public key')
    fingerprint='SHA256:'+base64.b64encode(hashlib.sha256(base64.b64decode(key[1],validate=True)).digest()).decode().rstrip('=')
    if fingerprint!=payload['fingerprint']:raise RuntimeError('Public key fingerprint mismatch')
    code=payload['gateway'].encode()
    if hashlib.sha256(code).hexdigest()!=payload['gatewaySha256']:raise RuntimeError('Gateway checksum mismatch')
    LIB.mkdir(mode=0o755,parents=True,exist_ok=True)
    STATE.mkdir(mode=0o700,parents=True,exist_ok=True)
    for directory in (LIB,STATE):
        if directory.is_symlink() or directory.stat().st_uid!=0 or directory.stat().st_mode&0o022:
            raise RuntimeError('Deployment control directory must be owned by root without group/other writes')
    stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
    def put(path,data,mode):
        if path.is_symlink():raise RuntimeError('Unexpected symlink: '+str(path))
        if path.exists() and path.read_bytes()!=data:
            backup=STATE/(path.name+'.before-'+stamp)
            with backup.open('xb') as stream:os.fchmod(stream.fileno(),0o600);stream.write(path.read_bytes())
        temporary=path.with_name(path.name+'.install-next')
        with temporary.open('xb') as stream:os.fchmod(stream.fileno(),mode);stream.write(data)
        temporary.replace(path)
    build_files={}
    for name in ('Dockerfile','.dockerignore'):
        blob=subprocess.check_output([*git_command,'show','HEAD:'+name])
        build_files[name]=hashlib.sha256(blob).hexdigest()
    put(LIB/'deploy-from-git.py',code,0o555)
    put(STATE/'policy.json',json.dumps({'source':str(source),'buildFiles':build_files},indent=2).encode(),0o600)
    wrapper=b'#!/bin/sh\nexec /usr/bin/sudo -n /usr/bin/python3 /usr/local/lib/seatraces/deploy-from-git.py --request "$SSH_ORIGINAL_COMMAND"\n'
    put(Path('/usr/local/bin/seatraces-deploy-gateway'),wrapper,0o555)
    # Verify the account's existing sudo permission. Never add a sudoers or Docker grant.
    result=subprocess.check_output(['runuser','-u','ubuntu','--','env','SSH_ORIGINAL_COMMAND=check','/usr/local/bin/seatraces-deploy-gateway'],text=True)
    check=json.loads(result)
    if not check.get('ok'):raise RuntimeError('Gateway self-check failed')
    auth=Path(account.pw_dir)/'.ssh/authorized_keys'
    if auth.is_symlink() or auth.parent.is_symlink():raise RuntimeError('Unexpected SSH symlink')
    old=auth.read_text() if auth.exists() else ''
    matches=[line for line in old.splitlines() if MARKER in line]
    if any(key[1] not in line for line in matches):raise RuntimeError('A different deployment key exists; revoke it explicitly first')
    line='restrict,command="/usr/local/bin/seatraces-deploy-gateway" '+key[0]+' '+key[1]+' '+MARKER
    updated='\n'.join([entry for entry in old.splitlines() if MARKER not in entry]+[line])+'\n'
    with (STATE/('authorized_keys.before-'+stamp)).open('x') as backup:
        os.fchmod(backup.fileno(),0o600);backup.write(old)
    auth.parent.mkdir(mode=0o700,exist_ok=True)
    auth.write_text(updated);auth.chmod(0o600)
    os.chown(auth.parent,account.pw_uid,account.pw_gid);os.chown(auth,account.pw_uid,account.pw_gid)
    receipt={'status':'installed','protocol':'seatraces-git-deploy/1','fingerprint':fingerprint,'expires':None,
             'allowedCommands':['check','deploy <main commit>','status <commit>'],'shellAllowed':False,
             'portForwardingAllowed':False,'productionRestarted':False,'newSudoGrant':False}
    put(STATE/'installation.json',json.dumps(receipt,indent=2).encode(),0o600)
    print(json.dumps(receipt,ensure_ascii=False,indent=2))

if __name__=='__main__':
    if 'PAYLOAD' not in globals():raise SystemExit('Use the generated, checksum-verified run-on-server.txt')
    main(PAYLOAD)
