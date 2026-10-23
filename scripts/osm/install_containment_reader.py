"""安装几何层级查询接口并验证结果。"""
from datetime import datetime,timezone
import json
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

ROOT=Path('/home/ubuntu/seatraces-osm')


def get(path):
    with urllib.request.urlopen('http://127.0.0.1:8791'+path,timeout=20) as response:return json.load(response)


def main():
    receipt=json.loads((ROOT/'audits/containment-hierarchy/receipt.json').read_text())
    target=ROOT/'scripts/osm';path=target/'place_service.py';text=path.read_text(encoding='utf8')
    hook="        if path in ('/hierarchy','/hierarchy-coverage'):\n            from containment_catalog import containment_get\n            return containment_get(self,path,params)\n"
    if hook not in text:
        anchor="        if path=='/health':"
        if text.count(anchor)!=1:raise ValueError('Reader route hook changed')
        text=text.replace(anchor,hook+anchor)
    replacement='        from containment_catalog import annotate_containment\n        return annotate_containment(self,annotate_sites(self,list(by_id.values())))'
    if replacement not in text:
        anchor='        return annotate_sites(self,list(by_id.values()))'
        if text.count(anchor)!=1:raise ValueError('Expected the deployed site reader; inspect before patching')
        text=text.replace(anchor,replacement)
    staged=Path(__file__).with_name('containment_catalog.py')
    compile(text,str(path),'exec');compile(staged.read_text(encoding='utf8'),str(staged),'exec')
    backup=ROOT/'backups'/('containment-reader-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(parents=True,exist_ok=False)
    shutil.copy2(path,backup/path.name)
    module=target/'containment_catalog.py'
    if module.exists():shutil.copy2(module,backup/module.name)
    shutil.copy2(staged,module);path.write_text(text,encoding='utf8')
    try:
        subprocess.run(['sudo','-n','systemctl','restart','seatraces-osm-catalog.service'],check=True,timeout=30)
        for attempt in range(12):
            try:
                health=get('/health');break
            except OSError:
                if attempt==11:raise
                time.sleep(.3)
        coverage=get('/hierarchy-coverage')
        if coverage['build']['build_id']!=receipt['buildId']:raise ValueError('Wrong hierarchy build')
        examples=[]
        for oid in ['osm:way/638449347','osm:relation/9511883']:
            result=get('/hierarchy?id='+oid+'&limit=20')
            if not result['item']:raise ValueError('Missing palace verification object')
            if result['item']['geometricHierarchy']['depth']>8:raise ValueError('Depth limit exceeded')
            examples.append(result)
        child=examples[0]['item']
        if child['geometricHierarchy']['geometryState']=='full_geometry' and not child['parentId']:
            raise ValueError('Taihe full geometry has no parent; inspect before publishing the reader')
        normal=get('/place?id=osm:way/638449347')
        if normal['item']['parentId']!=child['parentId']:raise ValueError('Normal place endpoint lost parent')
        report=dict(at=datetime.now(timezone.utc).isoformat(),buildId=receipt['buildId'],readerBackup=str(backup),
                    health=health,examples=examples,placeEndpointVerified=True)
        (ROOT/'audits/containment-hierarchy/reader-receipt.json').write_text(json.dumps(report,ensure_ascii=False,indent=2,default=str),encoding='utf8')
        print(json.dumps({'readerVerified':True,'buildId':receipt['buildId'],'taiheParent':child['parentId']}))
    except Exception:
        shutil.copy2(backup/path.name,path)
        if (backup/module.name).exists():shutil.copy2(backup/module.name,module)
        subprocess.run(['sudo','-n','systemctl','restart','seatraces-osm-catalog.service'],timeout=30)
        raise


if __name__=='__main__':main()
