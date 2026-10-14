"""Install only the additive site read endpoints after the server batch succeeds."""
from datetime import datetime,timezone
import json
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

ROOT=Path('/home/ubuntu/seatraces-osm')


def get(path):
    with urllib.request.urlopen('http://127.0.0.1:8791'+path,timeout=15) as r:
        return json.load(r)


def main():
    receipt=json.loads((ROOT/'audits/site-hierarchy/receipt.json').read_text())
    # The one-row active pointer needs accurate cardinality before queries join
    # several current_site views; the rebuild already analyzes the data tables.
    from rebuild_sites import connect
    with connect(ROOT) as conn:
        conn.execute('ANALYZE osm.site_builds')
        conn.execute('ANALYZE osm.site_active')
    target=ROOT/'scripts/osm'
    path=target/'place_service.py'
    text=path.read_text(encoding='utf8')
    before="        if path=='/health':"
    hook="        if path in ('/site','/site-coverage'):\n            from site_catalog import site_get\n            return site_get(self,path,params)\n"
    tail='        return list(by_id.values())'
    replacement='        from site_catalog import annotate_sites\n        return annotate_sites(self,list(by_id.values()))'
    if hook not in text:
        if text.count(before)!=1 or text.count(tail)!=1:raise ValueError('Reader changed; inspect before patching')
        text=text.replace(before,hook+before).replace(tail,replacement)
    compile(text,str(path),'exec')
    staged=Path(__file__).with_name('site_catalog.py')
    compile(staged.read_text(encoding='utf8'),str(staged),'exec')
    backup=ROOT/'backups'/('site-reader-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(parents=True,exist_ok=False)
    shutil.copy2(path,backup/path.name)
    module=target/'site_catalog.py'
    if module.exists():shutil.copy2(module,backup/module.name)
    shutil.copy2(staged,module)
    path.write_text(text,encoding='utf8')
    try:
        subprocess.run(['sudo','-n','systemctl','restart','seatraces-osm-catalog.service'],check=True,timeout=30)
        for attempt in range(10):
            try:
                health=get('/health');break
            except OSError:
                if attempt==9:raise
                time.sleep(.3)
        coverage=get('/site-coverage')
        if coverage['build']['build_id']!=receipt['buildId']:raise ValueError('Wrong active build')
        checks=[]
        for example in receipt['examples']:
            parent=get('/site?id='+example['parentId']+'&category='+example['category']+'&limit=200')
            child=get('/site?id='+example['childId'])
            if example['parentId'] not in [p['id'] for p in child['parents']]:raise ValueError('Parent readback failed')
            if child['item']['category']!=example['category']:raise ValueError('Category changed')
            checks.append(dict(parentId=example['parentId'],childId=example['childId'],category=example['category']))
        result=dict(at=datetime.now(timezone.utc).isoformat(),buildId=receipt['buildId'],
                    readerBackup=str(backup),health=health,checks=checks)
        (ROOT/'audits/site-hierarchy/reader-receipt.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps(result,ensure_ascii=True))
    except Exception:
        shutil.copy2(backup/path.name,path)
        if (backup/module.name).exists():shutil.copy2(backup/module.name,module)
        subprocess.run(['sudo','-n','systemctl','restart','seatraces-osm-catalog.service'],timeout=30)
        raise


if __name__=='__main__':main()
