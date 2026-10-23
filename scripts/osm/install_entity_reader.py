"""安装景点实体查询接口并验证结果。"""
import json
from pathlib import Path
import shutil
import subprocess
import time
import urllib.parse
import urllib.request
from rebuild_sites import connect, atomic, now

ROOT=Path('/home/ubuntu/seatraces-osm')


def get(path,**params):
    with urllib.request.urlopen('http://127.0.0.1:8791'+path+('?' + urllib.parse.urlencode(params) if params else ''),timeout=25) as response:
        return json.load(response)


def run():
    out=ROOT/'audits/entity-dedup';receipt=json.loads((out/'receipt.json').read_text())
    target=ROOT/'scripts/osm';service=target/'place_service.py'
    text=service.read_text(encoding='utf8')
    hook="from entity_catalog import install_entity_gateway\ninstall_entity_gateway(Gateway)\n\n"
    if hook not in text:
        anchor="if __name__=='__main__':"
        if text.count(anchor)!=1:raise ValueError('Reader entry point changed; refusing a blind replacement')
        text=text.replace(anchor,hook+anchor)
    compile(text,str(service),'exec')
    modules=['entity_identity.py','entity_catalog.py']
    for name in modules:compile(Path(__file__).with_name(name).read_text(encoding='utf8'),name,'exec')
    backup=ROOT/'backups'/('entity-reader-'+now().replace(':','').replace('+','-'))
    backup.mkdir(parents=True)
    for name in ['place_service.py',*modules]:
        if (target/name).exists():shutil.copy2(target/name,backup/name)
    for name in modules:shutil.copy2(Path(__file__).with_name(name),target/name)
    service.write_text(text,encoding='utf8')
    try:
        subprocess.run(['sudo','-n','systemctl','restart','seatraces-osm-catalog.service'],check=True,timeout=30)
        for attempt in range(15):
            try:health=get('/health');break
            except OSError:
                if attempt==14:raise
                time.sleep(.3)
        coverage=get('/entity-coverage')
        if not coverage['build'] or coverage['build']['build_id']!=receipt['buildId']:raise ValueError('Wrong canonical build')
        main='osm:relation/9511883';label='osm:node/3884441391';child='osm:way/638449347'
        legacy=get('/place',id=label)
        if legacy['item']['id']!=main or '故宫博物院' not in legacy['item']['aliases']:
            raise ValueError('Legacy ID or alias resolution failed')
        searches={q:get('/places',q=q,region='china',limit=30) for q in ['故宫','故宫博物院','Palace Museum']}
        for query,response in searches.items():
            ids=[p['id'] for p in response['items']]
            if ids.count(main)!=1 or label in ids or len(ids)!=len(set(ids)):
                raise ValueError('Search returned duplicate/missing canonical Palace: '+query)
        taihe=get('/place',id=child)
        if taihe['item']['id']!=child or taihe['item']['parentId']!=main:
            raise ValueError('Taihe was collapsed or detached')
        hierarchy=get('/hierarchy',id=label,limit=200)
        ids=[p['id'] for p in hierarchy['children']]
        if hierarchy['item']['id']!=main or label in ids or main in ids or child not in ids:
            raise ValueError('Canonical parent/children failed')
        batch=get('/place-batch',ids=','.join([main,label,child]))
        if {p['id'] for p in batch['items']}!={main,child} or len(batch['items'])!=2:
            raise ValueError('Batch lookup duplicated identities')
        cluster=get('/cluster-places',west=116.38,south=39.90,east=116.40,north=39.93)
        ids=[p['id'] for p in cluster['items']]
        if ids.count(main)!=1 or label in ids or child not in ids:
            raise ValueError('Clustering input still contains a duplicate Palace')
        report=dict(verifiedAt=now(),buildId=receipt['buildId'],readerBackup=str(backup),health=health,
                    coverage=coverage,legacy=legacy,searches=searches,taihe=taihe,hierarchy=hierarchy,
                    batchIds=[p['id'] for p in batch['items']],clusterVerified=True)
        atomic(out/'reader-receipt.json',report)
        print(json.dumps(dict(readerVerified=True,buildId=receipt['buildId'],palaceChildCount=hierarchy['item']['geometricHierarchy']['childCount'],backup=str(backup))))
    except BaseException:
        for name in ['place_service.py',*modules]:
            if (backup/name).exists():shutil.copy2(backup/name,target/name)
            elif name in modules:(target/name).unlink(missing_ok=True)
        pointer=json.loads((Path(receipt['backup'])/'receipt.json').read_text())
        with connect(ROOT) as conn:
            with conn.transaction():
                if pointer['previousBuild']:
                    conn.execute('UPDATE osm.entity_active SET build_id=%s WHERE singleton',(pointer['previousBuild'],))
                else:conn.execute('DELETE FROM osm.entity_active')
        subprocess.run(['sudo','-n','systemctl','restart','seatraces-osm-catalog.service'],timeout=30)
        raise


if __name__=='__main__':run()
