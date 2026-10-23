"""安装或撤销地点服务的 SSH 转发密钥。"""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re

ROOT=Path('/home/ubuntu/seatraces-osm')
MARKER='seatraces-catalog-development'

def key_line(public_key):
    parts=public_key.strip().split()
    if len(parts)<2 or parts[0]!='ssh-ed25519' or not re.fullmatch(r'[A-Za-z0-9+/=]{40,160}',parts[1]):
        raise ValueError('Expected one Ed25519 public key')
    options='restrict,port-forwarding,permitopen="127.0.0.1:8791",permitlisten="127.0.0.1:8791",command="/bin/false"'
    return f'{options} ssh-ed25519 {parts[1]} {MARKER}\n',parts[1]

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--public-key',type=Path,required=True)
    p.add_argument('--revoke',action='store_true')
    p.add_argument('--apply',action='store_true')
    args=p.parse_args()
    line,blob=key_line(args.public_key.read_text())
    if not args.apply:
        print(json.dumps({'validated':True,'applied':False,'operation':'revoke' if args.revoke else 'install','scope':'127.0.0.1:8791 only; no shell, SFTP, agent or X11'}));return
    target=Path('/home/ubuntu/.ssh/authorized_keys')
    with target.open('r+') as f:
        fcntl.flock(f,fcntl.LOCK_EX)
        original=f.read();lines=original.splitlines(keepends=True)
        matches=[x for x in lines if MARKER in x.split()]
        if any(blob not in x.split() for x in matches):raise RuntimeError('Another development key already uses this marker; inspect before replacement')
        if args.revoke:
            content=''.join(x for x in lines if not (MARKER in x.split() and blob in x.split()))
        elif matches:
            if len(matches)!=1 or matches[0].strip()!=line.strip():raise RuntimeError('Existing key restrictions differ')
            content=original
        else:
            if blob in original:raise RuntimeError('This public key already exists with another scope')
            content=original+('' if not original or original.endswith('\n') else '\n')+line
        f.seek(0);f.write(content);f.truncate();f.flush();os.fsync(f.fileno())
    target.chmod(0o600)
    report={'marker':MARKER,'operation':'revoked' if args.revoke else 'installed','at':datetime.now(timezone.utc).isoformat(),
        'remaining':sum(MARKER in x.split() and blob in x.split() for x in target.read_text().splitlines()),'scope':'catalog-loopback-only'}
    (ROOT/'catalog-development-access.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report))

if __name__=='__main__':main()
