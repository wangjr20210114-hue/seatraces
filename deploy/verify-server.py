"""检查已部署服务、数据库和外部接口配置。"""
from pathlib import Path
import json,sys,urllib.request,subprocess
root=Path('/home/ubuntu/seatraces-app');osm=Path('/home/ubuntu/seatraces-osm')
sys.path.insert(0,str(osm/'.deps'))
import psycopg
from psycopg import sql
cfg=json.loads((osm/'database.json').read_text());app=json.loads((root/'business-credentials.json').read_text())
cfg.update(user=app['user'],password=app['password'],dbname=app['database']);cfg.pop('database',None)
with psycopg.connect(**cfg) as c:
    c.execute('SET TRANSACTION READ ONLY')
    rights=c.execute("SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user").fetchone()
    create=c.execute("SELECT has_schema_privilege(current_user,'public','CREATE')").fetchone()[0]
    if any(rights) or create:raise SystemExit('Application role has excessive privileges')
    tables={t:c.execute(sql.SQL('SELECT count(*) FROM {}').format(sql.Identifier(t))).fetchone()[0] for t in ['users','places','trips','trip_versions','citywalks']}
    postgis=c.execute("SELECT extversion FROM pg_extension WHERE extname='postgis'").fetchone()[0]
report={'database':app['database'],'leastPrivilege':True,'tables':tables,'postgis':postgis,'http':{}}
settings=dict(line.split('=',1) for line in (root/'.env.deploy').read_text().splitlines() if '=' in line and not line.startswith('#'))
for name,url in [('backend','http://127.0.0.1:8787/api/health'),('frontend','http://'+settings['CADDY_BRIDGE_GATEWAY']+':8788/frontend-health'),('catalog','http://127.0.0.1:8791/health')]:
    with urllib.request.urlopen(url,timeout=15) as r:report['http'][name]={'status':r.status,'body':json.load(r)}
report['secretFilePrivate']=(root/'backend.env').stat().st_mode&0o777==0o600
report['ports']=subprocess.check_output(['ss','-lnt']).decode()
(root/'acceptance.json').write_text(json.dumps(report,indent=2,default=str))
print(json.dumps(report,default=str))
