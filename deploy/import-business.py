"""将业务数据迁移到独立 PostgreSQL 数据库。"""
from pathlib import Path
import argparse,gzip,hashlib,json,secrets,subprocess,sys,shutil,os
from urllib.parse import urlunsplit

parser=argparse.ArgumentParser()
parser.add_argument('--directory',required=True)
parser.add_argument('--apply',action='store_true')
args=parser.parse_args()
stage=Path(args.directory).resolve()
root=Path('/home/ubuntu/seatraces-app')
osm=Path('/home/ubuntu/seatraces-osm')
sys.path.insert(0,str(osm/'.deps'))
import psycopg
from psycopg import sql
cfg=json.loads((osm/'database.json').read_text())
manifest=json.loads((stage/'business-manifest.json').read_text())
digest=hashlib.sha256()
with gzip.open(stage/'business.sql.gz','rb') as f:
    for chunk in iter(lambda:f.read(1024*1024),b''):digest.update(chunk)
if digest.hexdigest()!=manifest['sha256']:raise SystemExit('Business archive checksum mismatch')
db='seatraces_business';owner='seatraces_business_owner';app='seatraces_business_app'
with psycopg.connect(**cfg,autocommit=True) as admin:
    if admin.execute('SELECT 1 FROM pg_database WHERE datname=%s',(db,)).fetchone():raise SystemExit('Target DB already exists; initial import will not overwrite it')
    if admin.execute('SELECT 1 FROM pg_roles WHERE rolname=ANY(%s)',([owner,app],)).fetchone():raise SystemExit('Target roles already exist; inspect previous deployment before retrying')
    print(json.dumps({'verified':True,'tables':len(manifest['counts']),'targetDatabase':db,'apply':args.apply}),flush=True)
    if not args.apply:raise SystemExit(0)
    root.mkdir(mode=0o700,parents=True,exist_ok=True)
    password=secrets.token_hex(32)
    credentials={'database':db,'owner':owner,'user':app,'password':password}
    secret=root/'business-credentials.json'
    if secret.exists():raise SystemExit('Credential file exists; inspect previous deployment')
    secret.write_text(json.dumps(credentials));secret.chmod(0o600)
    admin.execute(sql.SQL('CREATE ROLE {} NOLOGIN').format(sql.Identifier(owner)))
    admin.execute(sql.SQL('CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD {} CONNECTION LIMIT 12').format(sql.Identifier(app),sql.Literal(password)))
    admin.execute(sql.SQL('CREATE DATABASE {} OWNER {}').format(sql.Identifier(db),sql.Identifier(owner)))
    admin.execute(sql.SQL('REVOKE CONNECT ON DATABASE {} FROM PUBLIC').format(sql.Identifier(db)))
    admin.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(sql.Identifier(db),sql.Identifier(app)))
target={**cfg,'dbname':db};target.pop('database',None)
with psycopg.connect(**target,autocommit=True) as c:
    c.execute('CREATE EXTENSION IF NOT EXISTS postgis')
    c.execute('CREATE EXTENSION IF NOT EXISTS pg_trgm')
log=root/'migration.log'
with log.open('w') as output:
    log.chmod(0o600)
    process=subprocess.Popen(['docker','exec','-i','seatraces-osm-db','psql','-X','-v','ON_ERROR_STOP=1','-U',cfg['user'],'-d',db],stdin=subprocess.PIPE,stdout=output,stderr=output)
    try:
        process.stdin.write(('SET ROLE '+owner+';\n').encode())
        with gzip.open(stage/'business.sql.gz','rb') as data:shutil.copyfileobj(data,process.stdin)
        process.stdin.close()
        result=process.wait()
    except BrokenPipeError:result=process.wait()
    if result:raise SystemExit('Migration failed; see private migration.log. Existing OSM data is unchanged.')
with psycopg.connect(**target,autocommit=True) as c:
    counts={}
    for table,expected in manifest['counts'].items():
        actual=c.execute(sql.SQL('SELECT count(*) FROM {}').format(sql.Identifier(table))).fetchone()[0]
        if actual!=expected:raise SystemExit('Row count mismatch: '+table)
        counts[table]=actual
    c.execute('SET ROLE '+owner)
    c.execute((stage/'source/server/postgis.sql').read_text())
    c.execute(sql.SQL('GRANT USAGE ON SCHEMA public TO {}').format(sql.Identifier(app)))
    c.execute(sql.SQL('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO {}').format(sql.Identifier(app)))
    c.execute(sql.SQL('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO {}').format(sql.Identifier(app)))
    c.execute(sql.SQL('ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO {}').format(sql.Identifier(owner),sql.Identifier(app)))
    c.execute(sql.SQL('ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO {}').format(sql.Identifier(owner),sql.Identifier(app)))
    c.execute('RESET ROLE')
    c.execute('ANALYZE')
env=(stage/'providers.env').read_text()
connection_url=urlunsplit(('postgresql',app+':'+password+'@127.0.0.1:'+str(cfg.get('port',55432)),'/'+db,'',''))
env+='\nDATABASE_URL='+connection_url+'\nAPP_ORIGIN=https://trip.seatraces.com\nEMBEDDING_ENABLED=false\n'
envpath=root/'backend.env';envpath.write_text(env);envpath.chmod(0o600)
report={'imported':True,'database':db,'counts':counts,'sourceSha256':manifest['sha256'],'sessionsMigrated':False}
(root/'migration-verification.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report),flush=True)
