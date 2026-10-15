"""Prepare a local key and reviewable server installer; this never modifies the server."""
from pathlib import Path
import base64,hashlib,json,os,subprocess,zlib

ROOT=Path(__file__).resolve().parents[1]
RUNTIME=ROOT/'.runtime/deploy-access'
HOST='124.223.110.193'
HOST_FINGERPRINT='SHA256:8iHCpW4yWG9hlms96viHi4Oka0O7WgwY9Z0gKaSN2+4'

def fingerprint(blob):return 'SHA256:'+base64.b64encode(hashlib.sha256(base64.b64decode(blob)).digest()).decode().rstrip('=')

def main():
    RUNTIME.mkdir(parents=True,exist_ok=True)
    identity=RUNTIME/'id_ed25519'
    if not identity.exists():
        subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-C','seatraces-local-git-deploy','-f',str(identity)],check=True)
    if not (RUNTIME/'id_ed25519.pub').exists() or len((RUNTIME/'id_ed25519.pub').read_text().split())<2:
        public=subprocess.check_output(['ssh-keygen','-y','-f',str(identity)],text=True).strip()
        (RUNTIME/'id_ed25519.pub').write_text(public+' seatraces-local-git-deploy\n')
    if os.name=='nt':
        user=subprocess.check_output(['whoami'],text=True).strip()
        subprocess.run(['icacls',str(identity),'/inheritance:r','/grant:r',user+':F'],check=True,stdout=subprocess.DEVNULL)
    else:identity.chmod(0o600)
    # Reuse a previously verified host key. If absent, keyscan must match the pinned fingerprint.
    known=Path.home()/'.ssh/known_hosts'
    result=subprocess.run(['ssh-keygen','-F',HOST,'-f',str(known)],capture_output=True,text=True)
    lines=result.stdout.splitlines()
    if not any(' ssh-ed25519 ' in line for line in lines):
        result=subprocess.run(['ssh-keyscan','-T','8','-t','ed25519',HOST],capture_output=True,text=True,check=True)
        lines=result.stdout.splitlines()
    keys=[line.split()[2] for line in lines if not line.startswith('#') and len(line.split())>=3 and line.split()[1]=='ssh-ed25519']
    if len(keys)!=1 or fingerprint(keys[0])!=HOST_FINGERPRINT:raise RuntimeError('Server host key does not match the verified fingerprint; stopped')
    (RUNTIME/'known_hosts').write_text(HOST+' ssh-ed25519 '+keys[0]+'\n')
    public=(RUNTIME/'id_ed25519.pub').read_text().strip()
    code=(ROOT/'deploy/deploy-from-git.py').read_text(encoding='utf8')
    installer=(ROOT/'deploy/install-git-deploy.py').read_text(encoding='utf8')
    payload={'publicKey':public,'fingerprint':fingerprint(public.split()[1]),'gateway':code,'gatewaySha256':hashlib.sha256(code.encode()).hexdigest()}
    raw=json.dumps({'installer':installer,'payload':payload}).encode()
    digest=hashlib.sha256(raw).hexdigest();encoded=base64.b64encode(zlib.compress(raw,9)).decode()
    launcher="sudo python3 - <<'SEATRACES_DEPLOY_SETUP'\nimport base64,hashlib,json,zlib\nraw=zlib.decompress(base64.b64decode("+repr(encoded)+"))\nassert hashlib.sha256(raw).hexdigest()=="+repr(digest)+"\nv=json.loads(raw)\nexec(compile(v['installer'],'install-git-deploy.py','exec'),{'__name__':'__main__','PAYLOAD':v['payload']})\nSEATRACES_DEPLOY_SETUP\n"
    (RUNTIME/'run-on-server.txt').write_text(launcher,encoding='utf8')
    revoke="sudo python3 - <<'SEATRACES_DEPLOY_REVOKE'\nfrom pathlib import Path\np=Path('/home/ubuntu/.ssh/authorized_keys')\ns=p.read_text()\np.write_text(''.join(line for line in s.splitlines(True) if 'seatraces-local-git-deploy' not in line))\np.chmod(0o600)\nprint('Dedicated deployment key revoked. Other SSH keys preserved.')\nSEATRACES_DEPLOY_REVOKE\n"
    (RUNTIME/'revoke-on-server.txt').write_text(revoke,encoding='utf8')
    (RUNTIME/'config.json').write_text(json.dumps({'host':HOST,'user':'ubuntu','port':22,'identityFile':'.runtime/deploy-access/id_ed25519','knownHostsFile':'.runtime/deploy-access/known_hosts'},indent=2))
    print(json.dumps({'prepared':True,'installedOnServer':False,'fingerprint':payload['fingerprint'],'installer':str(RUNTIME/'run-on-server.txt'),'revocation':str(RUNTIME/'revoke-on-server.txt')}))

if __name__=='__main__':main()
